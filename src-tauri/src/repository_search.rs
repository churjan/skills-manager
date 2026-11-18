use crate::{ai, inventory, repository, Session};
use reqwest::{Client, StatusCode, Url};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, HashSet},
    path::PathBuf,
    time::Duration,
};
use tauri::State;

pub mod lookup;
pub mod updates;
use lookup::{Lookup, SearchError};

static SEARCH_GATE: tauri::async_runtime::Mutex<()> = tauri::async_runtime::Mutex::const_new(());

pub(crate) const CACHE: &str = "repositories.json";
type Cache = BTreeMap<String, String>;

pub fn apply_cached_repositories(skills: &mut [inventory::Skill]) {
    let Ok(cache) = ai::data_dir().and_then(|dir| ai::read_json::<Cache>(&dir, CACHE)) else {
        return;
    };
    for skill in skills.iter_mut().filter(|s| s.repository.is_none()) {
        skill.repository = cache
            .get(&skill.digest)
            .and_then(|url| repository::github_url(url));
    }
}

#[derive(Deserialize)]
struct SearchResults {
    items: Vec<Candidate>,
}

#[derive(Deserialize)]
struct Candidate {
    full_name: String,
    default_branch: String,
    fork: bool,
}

#[derive(Deserialize)]
struct SkillIndex {
    skills: Vec<IndexedSkill>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexedSkill {
    skill_id: String,
    source: String,
    installs: u64,
}

fn normalized(text: &str) -> String {
    text.trim_start_matches('\u{feff}')
        .trim()
        .replace("\r\n", "\n")
}

fn substantial_lines(body: &str) -> HashSet<&str> {
    body.lines()
        .map(str::trim)
        .filter(|line| line.len() >= 32 && !line.starts_with('#'))
        .collect()
}

fn matches_version(expected: &str, remote: &str) -> bool {
    if normalized(remote) == expected {
        return true;
    }
    let (name, _, local_body, _) = inventory::document(expected);
    let (other, _, remote_body, _) = inventory::document(remote);
    if name.is_none() || name != other {
        return false;
    }
    let local = substantial_lines(&local_body);
    let upstream = substantial_lines(&remote_body);
    let shared = local.intersection(&upstream).count();
    // Require many distinctive lines and substantial coverage of both versions.
    shared >= 20
        && shared * 100 >= 75 * local.len().min(upstream.len())
        && shared * 100 >= 30 * local.len().max(upstream.len())
}

async fn matches_file(
    client: &Client,
    url: Url,
    expected: &str,
    indexed: bool,
) -> Result<bool, SearchError> {
    let response = client.get(url).send().await?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(false);
    }
    let mut response = lookup::checked(response)?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Ok(false);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(std::str::from_utf8(&bytes).is_ok_and(|text| {
        if indexed {
            matches_version(expected, text)
        } else {
            normalized(text) == expected
        }
    }))
}

fn author_handle(text: &str) -> Option<String> {
    let text = normalized(text);
    let front = text.strip_prefix("---\n")?.split_once("\n---")?.0;
    let fields: serde_yaml::Value = serde_yaml::from_str(front).ok()?;
    let profile = Url::parse(fields.get("metadata")?.get("x")?.as_str()?).ok()?;
    if !matches!(profile.host_str(), Some("x.com" | "twitter.com")) {
        return None;
    }
    let handle = profile.path().trim_matches('/');
    (!handle.is_empty() && !handle.contains('/')).then(|| handle.to_owned())
}

async fn index_candidates(client: &Client, name: &str) -> Result<Vec<IndexedSkill>, SearchError> {
    let mut url = Url::parse("https://skills.sh/api/search").unwrap();
    url.query_pairs_mut()
        .append_pair("q", name)
        .append_pair("limit", "12");
    let response = client.get(url).send().await?;
    let mut results: SkillIndex = lookup::checked(response)?.json().await?;
    results.skills.retain(|entry| {
        entry.skill_id == name
            && repository::github_url(&format!("https://github.com/{}", entry.source)).is_some()
    });
    results
        .skills
        .sort_by_key(|entry| std::cmp::Reverse(entry.installs));
    Ok(results.skills)
}

async fn verified(
    client: &Client,
    repo: &Candidate,
    name: &str,
    expected: &str,
    indexed: bool,
) -> Result<bool, SearchError> {
    if repo.fork {
        return Ok(false);
    }
    let Some((owner, project)) = repo.full_name.split_once('/') else {
        return Ok(false);
    };
    for path in [
        vec!["skills", name, "SKILL.md"],
        vec![".agents", "skills", name, "SKILL.md"],
        vec!["skills", ".curated", name, "SKILL.md"],
        vec!["SKILL.md"],
        vec![name, "SKILL.md"],
    ] {
        let mut url = Url::parse("https://raw.githubusercontent.com").unwrap();
        url.path_segments_mut()
            .unwrap()
            .extend([owner, project, &repo.default_branch])
            .extend(path);
        if matches_file(client, url, expected, indexed).await? {
            return Ok(true);
        }
    }
    Ok(false)
}

async fn client() -> Result<Client, SearchError> {
    Ok(crate::network::client_builder()
        .await
        .map_err(|_| SearchError::Network)?
        .user_agent("SkillsManager")
        .timeout(Duration::from_secs(8))
        .build()?)
}

async fn discover(name: &str, text: &str) -> Result<Option<String>, SearchError> {
    if name.is_empty()
        || name.len() > 100
        || !name
            .chars()
            .all(|c| c.is_alphanumeric() || "-_.".contains(c))
        || matches!(name, "." | "..")
    {
        return Ok(None);
    }
    let client = client().await?;
    let expected = normalized(text);
    let (indexed, index_failed) = match index_candidates(&client, name).await {
        Ok(entries) => (entries, false),
        Err(error @ SearchError::RateLimited(_)) => return Err(error),
        Err(_) => (Vec::new(), true),
    };
    let mut matched = None;
    let mut checked = HashSet::new();
    for (i, entry) in indexed.iter().take(3).enumerate() {
        let response = client
            .get(format!("https://api.github.com/repos/{}", entry.source))
            .send()
            .await?;
        if response.status() == StatusCode::NOT_FOUND {
            continue;
        }
        let repo: Candidate = lookup::checked(response)?.json().await?;
        checked.insert(repo.full_name.clone());
        let Some(url) = repository::github_url(&format!("https://github.com/{}", repo.full_name))
        else {
            continue;
        };
        if verified(&client, &repo, name, &expected, true).await? {
            // Only prefer the leading index entry when the file also matches and
            // the next same-name entry is substantially less established.
            if i == 0
                && indexed
                    .get(1)
                    .is_none_or(|next| entry.installs >= next.installs.max(1).saturating_mul(10))
            {
                return Ok(Some(url));
            }
            if matched.is_some() {
                return Ok(None);
            }
            matched = Some(url);
        }
    }
    if matched.is_some() {
        return Ok(matched);
    }
    let query = format!("{name} in:name,description fork:false");
    let mut search = Url::parse("https://api.github.com/search/repositories").unwrap();
    search
        .query_pairs_mut()
        .append_pair("q", &query)
        .append_pair("per_page", "3");
    let response = client.get(search).send().await?;
    let results: SearchResults = lookup::checked(response)?.json().await?;
    let author = author_handle(text);
    let mut ambiguous = false;
    for candidate in results.items {
        if checked.contains(&candidate.full_name) {
            continue;
        }
        let Some(repo) =
            repository::github_url(&format!("https://github.com/{}", candidate.full_name))
        else {
            continue;
        };
        if verified(&client, &candidate, name, &expected, false).await? {
            let owner = candidate.full_name.split('/').next().unwrap_or_default();
            if author
                .as_deref()
                .is_some_and(|handle| handle.eq_ignore_ascii_case(owner))
            {
                return Ok(Some(repo));
            }
            ambiguous |= matched.is_some();
            matched = Some(repo);
        }
    }
    if matched.is_none() && index_failed {
        return Err(SearchError::Network);
    }
    Ok(if ambiguous { None } else { matched })
}

#[tauri::command]
pub fn load_repository_lookups() -> Result<lookup::LookupCache, String> {
    lookup::load(&ai::data_dir()?)
}

#[tauri::command]
pub async fn find_github_repository(
    directory: PathBuf,
    id: String,
    force: bool,
    session: State<'_, Session>,
) -> Result<Lookup, String> {
    // Serialize discoveries so a limit seen by one lookup blocks every queued lookup.
    let _gate = SEARCH_GATE.lock().await;
    let text = ai::scanned_document(&directory, &id, &session)?;
    let dir = ai::data_dir()?;
    if let Some(result) = lookup::cached(&dir, &id, force, lookup::now())? {
        return Ok(result);
    }
    let name = inventory::document(&text).0;
    let name = name
        .as_deref()
        .or_else(|| directory.file_name()?.to_str())
        .unwrap_or_default();
    let result = match discover(name, &text).await {
        Ok(Some(url)) => Lookup::Found { url },
        Ok(None) => Lookup::Missing {
            retry_at: lookup::now().saturating_add(lookup::MISSING_TTL),
        },
        Err(error) => error.outcome(lookup::now()),
    };
    let installed = ai::scanned_document(&directory, &id, &session).is_ok();
    lookup::store(&dir, &id, &result, installed)?;
    if !installed {
        return Err("技能内容已变化，请重新扫描".into());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indexed_versions_need_matching_names_and_distinctive_body_content() {
        let lines = (0..32)
            .map(|n| format!("Implementation note {n}: preserve and verify example number {n}."))
            .collect::<Vec<_>>()
            .join("\n");
        let local = format!("---\nname: widget\n---\n{lines}");
        let newer = format!("{local}\nA newly documented example for this release.");
        assert!(matches_version(&local, &newer));
        assert!(!matches_version(
            &local,
            &newer.replace("name: widget", "name: other")
        ));
        assert!(!matches_version(
            &local,
            "---\nname: widget\n---\nUnrelated implementation"
        ));
    }
}
