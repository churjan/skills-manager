use reqwest::Url;
use serde_yaml::Value;
use std::{collections::HashMap, fs, path::Path};

/// Return only a public web address, never remote credentials or query parameters.
pub fn github_url(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let parsed = if let Some(path) = raw.strip_prefix("git@github.com:") {
        Url::parse(&format!("https://github.com/{path}")).ok()?
    } else {
        Url::parse(raw).ok()?
    };
    if !matches!(parsed.scheme(), "https" | "http" | "ssh" | "git")
        || !matches!(parsed.host_str(), Some("github.com" | "www.github.com"))
    {
        return None;
    }
    let mut parts = parsed.path_segments()?;
    let owner = parts.next()?;
    let name = parts.next()?.trim_end_matches(".git");
    let valid = |s: &str| {
        !s.is_empty()
            && s != "."
            && s != ".."
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    };
    if !valid(owner) || !valid(name) || !matches!(parts.next(), None | Some("" | "tree" | "blob")) {
        return None;
    }
    Some(format!("https://github.com/{owner}/{name}"))
}

pub fn declared(fields: &Value) -> Option<String> {
    let metadata = fields.get("metadata");
    [
        Some(fields),
        metadata,
        metadata.and_then(|m| m.get("openclaw")),
    ]
    .into_iter()
    .flatten()
    .find_map(|map| {
        ["repository", "homepage", "source"]
            .into_iter()
            .find_map(|key| {
                let field = map.get(key)?;
                github_url(field.as_str().or_else(|| field.get("url")?.as_str())?)
            })
    })
}

pub struct Installed {
    pub url: String,
    pub tracked: Option<Tracked>,
}

/// Upstream location recorded by `npx skills`, used to detect newer versions.
#[derive(Clone, Debug, PartialEq)]
pub struct Tracked {
    pub repo: String,
    pub folder: String,
    pub hash: String,
}

fn tracked(url: &str, entry: &serde_json::Value) -> Option<Tracked> {
    let repo = url.strip_prefix("https://github.com/")?.to_owned();
    let folder = entry["skillPath"]
        .as_str()?
        .strip_suffix("SKILL.md")?
        .trim_end_matches('/')
        .to_owned();
    let hash = entry["skillFolderHash"].as_str()?;
    (!hash.is_empty()).then(|| Tracked { repo, folder, hash: hash.to_owned() })
}

pub fn installed(home: &Path) -> HashMap<String, Installed> {
    let Ok(text) = fs::read_to_string(home.join(".agents/.skill-lock.json")) else {
        return HashMap::new();
    };
    let lock: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
    let Some(skills) = lock["skills"].as_object() else {
        return HashMap::new();
    };
    skills
        .iter()
        .filter_map(|(name, entry)| {
            let url = entry["sourceUrl"]
                .as_str()
                .and_then(github_url)
                .or_else(|| {
                    if entry["sourceType"].as_str()? != "github" {
                        return None;
                    }
                    github_url(&format!("https://github.com/{}", entry["source"].as_str()?))
                })?;
            let tracked = tracked(&url, entry);
            Some((name.clone(), Installed { url, tracked }))
        })
        .collect()
}

pub fn origin(skill: &Path) -> Option<String> {
    let root = skill.ancestors().find(|dir| dir.join(".git").exists())?;
    let marker = root.join(".git");
    let git_dir = if marker.is_file() {
        root.join(
            fs::read_to_string(marker)
                .ok()?
                .trim()
                .strip_prefix("gitdir:")?
                .trim(),
        )
    } else {
        marker
    };
    let common = fs::read_to_string(git_dir.join("commondir")).ok();
    let config = fs::read_to_string(
        git_dir
            .join(common.as_deref().unwrap_or("").trim())
            .join("config"),
    )
    .ok()?;
    let mut in_origin = false;
    for line in config.lines().map(str::trim) {
        if line.starts_with('[') {
            in_origin = line.eq_ignore_ascii_case("[remote \"origin\"]");
        } else if in_origin {
            if let Some((key, value)) = line.split_once('=') {
                if key.trim().eq_ignore_ascii_case("url") {
                    return github_url(value.trim().trim_matches('"'));
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_repo_sources_without_forwarding_credentials_or_unrelated_hosts() {
        for source in [
            "git@github.com:org/tool.git",
            "https://github.com/org/tool/tree/main/skills",
            "https://user:token@github.com/org/tool.git?key=example",
            "https://www.github.com/org/tool",
        ] {
            assert_eq!(
                github_url(source).as_deref(),
                Some("https://github.com/org/tool")
            );
        }
        for source in [
            "https://github.com.example.org/org/tool",
            "file:///org/tool",
            "https://github.com/org",
        ] {
            assert!(github_url(source).is_none());
        }
    }

    #[test]
    fn lock_entries_record_the_upstream_folder_and_hash() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir_all(home.path().join(".agents")).unwrap();
        fs::write(
            home.path().join(".agents/.skill-lock.json"),
            serde_json::json!({"skills": {
                "nested": {"sourceUrl": "https://github.com/org/tool.git", "skillPath": "skills/nested/SKILL.md", "skillFolderHash": "abc"},
                "root": {"source": "org/single", "sourceType": "github", "skillPath": "SKILL.md", "skillFolderHash": "def"},
                "untracked": {"sourceUrl": "https://github.com/org/tool"}
            }})
            .to_string(),
        )
        .unwrap();
        let lock = installed(home.path());
        assert_eq!(
            lock["nested"].tracked,
            Some(Tracked { repo: "org/tool".into(), folder: "skills/nested".into(), hash: "abc".into() })
        );
        assert_eq!(lock["root"].tracked.as_ref().unwrap().folder, "");
        assert_eq!(lock["untracked"].url, "https://github.com/org/tool");
        assert!(lock["untracked"].tracked.is_none());
    }
}
