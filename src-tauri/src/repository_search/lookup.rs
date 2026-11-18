use crate::{ai, repository};
use reqwest::{header::HeaderMap, Response, StatusCode};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

const LOOKUPS: &str = "repository-lookups.json";
pub const MISSING_TTL: u64 = 7 * 24 * 60 * 60;
pub const ERROR_TTL: u64 = 5 * 60;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Lookup {
    Found { url: String },
    Missing { retry_at: u64 },
    Error { retry_at: u64 },
    RateLimited { retry_at: u64 },
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupCache {
    pub entries: BTreeMap<String, Lookup>,
    pub rate_limit_until: u64,
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn load(dir: &Path) -> Result<LookupCache, String> {
    ai::read_json(dir, LOOKUPS)
}

pub fn cached(dir: &Path, id: &str, force: bool, now: u64) -> Result<Option<Lookup>, String> {
    let successes: super::Cache = ai::read_json(dir, super::CACHE)?;
    if let Some(url) = successes
        .get(id)
        .and_then(|url| repository::github_url(url))
    {
        return Ok(Some(Lookup::Found { url }));
    }
    let cache = load(dir)?;
    if cache.rate_limit_until > now {
        return Ok(Some(Lookup::RateLimited {
            retry_at: cache.rate_limit_until,
        }));
    }
    Ok(cache
        .entries
        .get(id)
        .filter(|entry| match entry {
            Lookup::Missing { retry_at } | Lookup::Error { retry_at } => !force && *retry_at > now,
            Lookup::RateLimited { retry_at } => *retry_at > now,
            _ => false,
        })
        .cloned())
}

pub fn store(dir: &Path, id: &str, result: &Lookup, still_installed: bool) -> Result<(), String> {
    let _lock = ai::lock_file(dir, "repositories.lock")?;
    let mut cache = load(dir)?;
    if let Lookup::RateLimited { retry_at } = result {
        cache.rate_limit_until = cache.rate_limit_until.max(*retry_at);
    }
    if still_installed {
        if let Lookup::Found { url } = result {
            let mut successes: super::Cache = ai::read_json(dir, super::CACHE)?;
            successes.insert(id.to_owned(), url.clone());
            ai::write_json(dir, super::CACHE, &successes)?;
            cache.entries.remove(id);
        } else {
            cache.entries.insert(id.to_owned(), result.clone());
        }
    }
    ai::write_json(dir, LOOKUPS, &cache)
}

pub fn prune(dir: &Path, active: &HashSet<&str>) -> Result<(), String> {
    if !dir.join(LOOKUPS).try_exists().map_err(|e| e.to_string())? {
        return Ok(());
    }
    let _lock = ai::lock_file(dir, "repositories.lock")?;
    let mut cache = load(dir)?;
    let before = cache.entries.len();
    cache.entries.retain(|id, _| active.contains(id.as_str()));
    if cache.entries.len() != before {
        ai::write_json(dir, LOOKUPS, &cache)?;
    }
    Ok(())
}

#[derive(Debug)]
pub enum SearchError {
    Network,
    RateLimited(u64),
}

impl From<reqwest::Error> for SearchError {
    fn from(_: reqwest::Error) -> Self {
        Self::Network
    }
}

impl SearchError {
    pub fn outcome(self, now: u64) -> Lookup {
        match self {
            Self::Network => Lookup::Error {
                retry_at: now.saturating_add(ERROR_TTL),
            },
            Self::RateLimited(retry_at) => Lookup::RateLimited { retry_at },
        }
    }
}

fn header_u64(headers: &HeaderMap, name: &str) -> Option<u64> {
    headers.get(name)?.to_str().ok()?.parse().ok()
}

fn rate_limit(status: StatusCode, headers: &HeaderMap, now: u64) -> Option<u64> {
    let retry_after = headers
        .get("retry-after")
        .and_then(|value| value.to_str().ok());
    let reset = header_u64(headers, "x-ratelimit-reset");
    let exhausted = header_u64(headers, "x-ratelimit-remaining") == Some(0);
    if status != StatusCode::TOO_MANY_REQUESTS
        && !(status == StatusCode::FORBIDDEN && (retry_after.is_some() || exhausted))
    {
        return None;
    }
    let retry_at = retry_after.and_then(|value| {
        value
            .parse::<u64>()
            .ok()
            .map(|seconds| now.saturating_add(seconds))
            .or_else(|| {
                chrono::DateTime::parse_from_rfc2822(value)
                    .ok()
                    .and_then(|date| date.timestamp().try_into().ok())
            })
    });
    // Respect all deadlines provided by the server; use five minutes when none is supplied.
    Some(
        retry_at
            .into_iter()
            .chain(reset)
            .max()
            .unwrap_or(now.saturating_add(ERROR_TTL))
            .max(now.saturating_add(1)),
    )
}

pub fn checked(response: Response) -> Result<Response, SearchError> {
    if let Some(until) = rate_limit(response.status(), response.headers(), now()) {
        return Err(SearchError::RateLimited(until));
    }
    Ok(response.error_for_status()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_and_network_failures_survive_restarts_and_manual_retry_bypasses_them() {
        let dir = tempfile::tempdir().unwrap();
        for (id, entry, ttl) in [
            (
                "missing",
                Lookup::Missing {
                    retry_at: 100 + MISSING_TTL,
                },
                MISSING_TTL,
            ),
            (
                "network",
                Lookup::Error {
                    retry_at: 100 + ERROR_TTL,
                },
                ERROR_TTL,
            ),
        ] {
            store(dir.path(), id, &entry, true).unwrap();
            assert_eq!(cached(dir.path(), id, false, 101).unwrap(), Some(entry));
            assert_eq!(cached(dir.path(), id, true, 101).unwrap(), None);
            assert_eq!(cached(dir.path(), id, false, 100 + ttl).unwrap(), None);
        }
        // A changed document has another digest and does not inherit a negative result.
        assert_eq!(cached(dir.path(), "changed", false, 101).unwrap(), None);
    }

    #[test]
    fn rate_limit_applies_to_other_skills_and_force_even_after_pruning() {
        let dir = tempfile::tempdir().unwrap();
        store(
            dir.path(),
            "old",
            &Lookup::RateLimited { retry_at: 500 },
            false,
        )
        .unwrap();
        prune(dir.path(), &HashSet::new()).unwrap();
        assert_eq!(
            cached(dir.path(), "new", true, 499).unwrap(),
            Some(Lookup::RateLimited { retry_at: 500 })
        );
        assert_eq!(cached(dir.path(), "new", false, 500).unwrap(), None);
    }

    #[test]
    fn success_keeps_legacy_format_and_removes_negative_result() {
        let dir = tempfile::tempdir().unwrap();
        store(
            dir.path(),
            "skill",
            &Lookup::Missing { retry_at: 1000 },
            true,
        )
        .unwrap();
        let found = Lookup::Found {
            url: "https://github.com/org/repo".into(),
        };
        store(dir.path(), "skill", &found, true).unwrap();
        store(
            dir.path(),
            "another",
            &Lookup::RateLimited { retry_at: 500 },
            true,
        )
        .unwrap();
        assert_eq!(
            cached(dir.path(), "skill", false, 100).unwrap(),
            Some(found)
        );
        assert!(load(dir.path()).unwrap().entries.get("skill").is_none());
        let legacy: super::super::Cache = ai::read_json(dir.path(), super::super::CACHE).unwrap();
        assert_eq!(legacy["skill"], "https://github.com/org/repo");
    }

    #[test]
    fn prune_removes_old_digests_but_preserves_shared_results() {
        let dir = tempfile::tempdir().unwrap();
        for id in ["deleted", "shared"] {
            store(dir.path(), id, &Lookup::Missing { retry_at: 1000 }, true).unwrap();
        }
        prune(dir.path(), &HashSet::from(["shared"])).unwrap();
        let cache = load(dir.path()).unwrap();
        assert_eq!(cache.entries.len(), 1);
        assert!(cache.entries.contains_key("shared"));
    }

    #[test]
    fn classifies_retry_after_seconds_dates_and_github_reset() {
        let mut headers = HeaderMap::new();
        headers.insert("retry-after", "60".parse().unwrap());
        assert_eq!(
            rate_limit(StatusCode::TOO_MANY_REQUESTS, &headers, 100),
            Some(160)
        );
        headers.insert(
            "retry-after",
            "Wed, 21 Oct 2015 07:28:00 GMT".parse().unwrap(),
        );
        assert_eq!(
            rate_limit(StatusCode::TOO_MANY_REQUESTS, &headers, 100),
            Some(1445412480)
        );
        headers.remove("retry-after");
        headers.insert("x-ratelimit-remaining", "0".parse().unwrap());
        headers.insert("x-ratelimit-reset", "500".parse().unwrap());
        assert_eq!(rate_limit(StatusCode::FORBIDDEN, &headers, 100), Some(500));
        headers.insert("retry-after", "600".parse().unwrap());
        assert_eq!(rate_limit(StatusCode::FORBIDDEN, &headers, 100), Some(700));
        assert_eq!(rate_limit(StatusCode::OK, &headers, 100), None);
        assert_eq!(
            rate_limit(StatusCode::FORBIDDEN, &HeaderMap::new(), 100),
            None
        );
        assert_eq!(
            rate_limit(StatusCode::TOO_MANY_REQUESTS, &HeaderMap::new(), 100),
            Some(400)
        );
    }
}
