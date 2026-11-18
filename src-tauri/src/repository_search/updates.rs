use super::{
    lookup::{self, Lookup, SearchError},
    SEARCH_GATE,
};
use crate::{ai, repository};
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const UPDATES: &str = "skill-updates.json";
const UPDATE_TTL: u64 = 24 * 60 * 60;

static UPDATE_GATE: tauri::async_runtime::Mutex<()> = tauri::async_runtime::Mutex::const_new(());

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoTree {
    checked_at: u64,
    folders: BTreeMap<String, Option<String>>,
}

type Cache = BTreeMap<String, RepoTree>;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Update {
    Latest,
    Available,
}

#[derive(Deserialize)]
struct Tree {
    sha: String,
    tree: Vec<TreeEntry>,
}

#[derive(Deserialize)]
struct TreeEntry {
    path: String,
    #[serde(rename = "type")]
    kind: String,
    sha: String,
}

fn folders(tree: Option<Tree>, wanted: &[&str]) -> BTreeMap<String, Option<String>> {
    wanted
        .iter()
        .map(|&folder| {
            let sha = tree.as_ref().and_then(|tree| {
                if folder.is_empty() {
                    return Some(tree.sha.clone());
                }
                tree.tree
                    .iter()
                    .find(|entry| entry.kind == "tree" && entry.path == folder)
                    .map(|entry| entry.sha.clone())
            });
            (folder.to_owned(), sha)
        })
        .collect()
}

async fn fetch(client: &Client, repo: &str) -> Result<Option<Tree>, SearchError> {
    let response = client
        .get(format!("https://api.github.com/repos/{repo}/git/trees/HEAD?recursive=1"))
        .send()
        .await?;
    // Deleted, private and empty repositories cannot report a newer version.
    if matches!(response.status(), StatusCode::NOT_FOUND | StatusCode::CONFLICT) {
        return Ok(None);
    }
    Ok(Some(lookup::checked(response)?.json().await?))
}

#[tauri::command]
pub async fn check_skill_updates() -> Result<BTreeMap<String, Update>, String> {
    let _updates = UPDATE_GATE.lock().await;
    let home = dirs::home_dir().ok_or("无法定位用户目录")?;
    let managed = home.join(".agents/skills");
    let tracked: Vec<_> = repository::installed(&home)
        .into_iter()
        .filter(|(name, _)| managed.join(name).join("SKILL.md").is_file())
        .filter_map(|(name, entry)| Some((name, entry.tracked?)))
        .collect();
    let mut groups = BTreeMap::<&str, Vec<&str>>::new();
    for (_, skill) in &tracked {
        groups.entry(&skill.repo).or_default().push(&skill.folder);
    }
    let dir = ai::data_dir()?;
    let mut cache: Cache = ai::read_json(&dir, UPDATES)?;
    let now = lookup::now();
    let mut client = None;
    for (&repo, wanted) in &groups {
        let fresh = cache.get(repo).is_some_and(|cached| {
            cached.checked_at <= now
                && now < cached.checked_at.saturating_add(UPDATE_TTL)
                && wanted.iter().all(|folder| cached.folders.contains_key(*folder))
        });
        if fresh {
            continue;
        }
        let _gate = SEARCH_GATE.lock().await;
        if lookup::load(&dir)?.rate_limit_until > now {
            break;
        }
        if client.is_none() {
            client = Some(super::client().await.map_err(|_| "无法创建网络连接")?);
        }
        match fetch(client.as_ref().unwrap(), repo).await {
            Ok(tree) => {
                let folders = folders(tree, wanted);
                cache.insert(repo.to_owned(), RepoTree { checked_at: now, folders });
            }
            Err(SearchError::RateLimited(retry_at)) => {
                lookup::store(&dir, "", &Lookup::RateLimited { retry_at }, false)?;
                break;
            }
            // Keep any older result and retry this repository on the next scan.
            Err(SearchError::Network) => {}
        }
    }
    cache.retain(|repo, _| groups.contains_key(repo.as_str()));
    ai::write_json(&dir, UPDATES, &cache)?;
    Ok(tracked
        .iter()
        .filter_map(|(name, skill)| {
            let upstream = cache.get(&skill.repo)?.folders.get(&skill.folder)?.as_ref()?;
            let update = if *upstream == skill.hash { Update::Latest } else { Update::Available };
            Some((name.clone(), update))
        })
        .collect())
}

fn changes_url(skill: &repository::Tracked) -> Option<String> {
    let mut url = Url::parse(&format!("https://github.com/{}", skill.repo)).ok()?;
    url.path_segments_mut()
        .ok()?
        .extend(["commits", "HEAD"])
        .extend(skill.folder.split('/').filter(|part| !part.is_empty()));
    Some(url.into())
}

/// Open the upstream history of an installed skill so its changes can be reviewed.
#[tauri::command]
pub fn open_skill_changes(name: String) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("无法定位用户目录")?;
    let url = repository::installed(&home)
        .remove(&name)
        .and_then(|entry| entry.tracked)
        .and_then(|skill| changes_url(&skill))
        .ok_or("找不到这个技能的上游记录")?;
    crate::open_url(&url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders_use_the_root_tree_or_matching_subtrees() {
        let tree = Tree {
            sha: "root".into(),
            tree: vec![
                TreeEntry { path: "skills/a".into(), kind: "tree".into(), sha: "a1".into() },
                TreeEntry { path: "skills/b".into(), kind: "blob".into(), sha: "b1".into() },
            ],
        };
        let found = folders(Some(tree), &["", "skills/a", "skills/b", "skills/c"]);
        assert_eq!(found[""].as_deref(), Some("root"));
        assert_eq!(found["skills/a"].as_deref(), Some("a1"));
        assert_eq!(found["skills/b"], None);
        assert_eq!(found["skills/c"], None);
        assert_eq!(folders(None, &["skills/a"])["skills/a"], None);
    }

    #[test]
    fn change_history_points_at_the_skill_folder() {
        let skill = |folder: &str| repository::Tracked {
            repo: "org/tool".into(),
            folder: folder.into(),
            hash: "abc".into(),
        };
        assert_eq!(
            changes_url(&skill("skills/my skill")).as_deref(),
            Some("https://github.com/org/tool/commits/HEAD/skills/my%20skill")
        );
        assert_eq!(
            changes_url(&skill("")).as_deref(),
            Some("https://github.com/org/tool/commits/HEAD")
        );
    }
}
