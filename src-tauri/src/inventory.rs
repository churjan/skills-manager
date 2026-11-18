use serde::Serialize;
use std::{
    collections::{BTreeMap, HashSet},
    env, fs, io,
    io::Read,
    path::{Path, PathBuf},
};

const KNOWN: &[&str] = &[
    ".agents",
    ".codex",
    ".cursor",
    ".claude",
    ".github",
    ".gemini",
    ".gemini/antigravity",
    ".config/opencode",
    ".codeium/windsurf",
    ".roo",
    ".kilocode",
    ".opencode",
];
const EXCLUDED: &[&str] = &[
    ".system",
    ".git",
    "node_modules",
    "__pycache__",
    ".skills-manager-trash",
    "trash",
    ".trash",
    "cache",
    ".cache",
    "plugins",
    ".plugins",
];
const MAX_DOCUMENT: u64 = 2 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub name: String,
    pub display_name: String,
    pub directory: PathBuf,
    pub target: PathBuf,
    pub linked: bool,
    pub root: PathBuf,
    pub label: String,
    pub description: String,
    pub body: String,
    pub digest: String,
    pub repository: Option<String>,
    pub version: Option<String>,
    /// Name of the `.skill-lock.json` entry whose upstream hash can be checked.
    pub lock_name: Option<String>,
    pub modified_at: Option<u64>,
    pub installed_at: Option<u64>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    pub skills: Vec<Skill>,
    pub errors: Vec<String>,
    pub physical_count: usize,
}

fn key(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").to_lowercase()
}

fn excluded(path: &Path) -> bool {
    path.components().any(|part| {
        let name = part.as_os_str().to_string_lossy();
        EXCLUDED.iter().any(|skip| name.eq_ignore_ascii_case(skip))
    })
}

#[derive(Debug, Default, PartialEq)]
pub(crate) struct Meta {
    pub repository: Option<String>,
    pub version: Option<String>,
}

fn version(fields: &serde_yaml::Value) -> Option<String> {
    [Some(fields), fields.get("metadata")]
        .into_iter()
        .flatten()
        .find_map(|map| {
            let value = map.get("version")?;
            let text = value.as_str().map(str::to_owned).or_else(|| match value {
                serde_yaml::Value::Number(number) => Some(number.to_string()),
                _ => None,
            })?;
            let text = text.trim();
            let text = text.strip_prefix(['v', 'V']).unwrap_or(text);
            (!text.is_empty() && text.len() <= 32 && !text.contains(char::is_whitespace))
                .then(|| text.to_owned())
        })
}

pub(crate) fn document(text: &str) -> (Option<String>, String, String, Meta) {
    let normalized = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    if let Some(front) = normalized.strip_prefix("---\n") {
        let mut offset = 0;
        for line in front.split_inclusive('\n') {
            if matches!(line.trim_end(), "---" | "...") {
                let fields = serde_yaml::from_str::<serde_yaml::Value>(&front[..offset]).ok();
                let field = |key: &str| fields.as_ref()?.get(key)?.as_str();
                let name = field("name").map(str::trim).filter(|name| !name.is_empty());
                return (
                    name.map(str::to_owned),
                    field("description").unwrap_or_default().to_owned(),
                    front[offset + line.len()..].trim_start().to_owned(),
                    Meta {
                        repository: fields.as_ref().and_then(crate::repository::declared),
                        version: fields.as_ref().and_then(version),
                    },
                );
            }
            offset += line.len();
        }
    }
    (None, String::new(), normalized, Meta::default())
}

fn format_skill_name(name: &str) -> String {
    let words = name
        .split(|c: char| c == '-' || c == '_' || c.is_whitespace())
        .filter(|word| !word.is_empty());
    let mut title = String::new();
    for word in words {
        let first = title.is_empty();
        if !first {
            title.push(' ');
        }
        if !first
            && matches!(
                word,
                "a" | "an"
                    | "and"
                    | "as"
                    | "at"
                    | "by"
                    | "for"
                    | "in"
                    | "of"
                    | "on"
                    | "or"
                    | "the"
                    | "to"
                    | "with"
            )
        {
            title.push_str(word);
        } else if let Some(initial) = word.chars().next() {
            title.extend(initial.to_uppercase());
            title.push_str(&word[initial.len_utf8()..]);
        }
    }
    if title.is_empty() {
        name.to_owned()
    } else {
        title
    }
}

pub fn read_document(path: &Path) -> io::Result<String> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(MAX_DOCUMENT + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_DOCUMENT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "文件超过 2 MiB 预览上限",
        ));
    }
    String::from_utf8(bytes).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

impl Inventory {
    fn error(&mut self, path: &Path, error: impl std::fmt::Display) {
        self.errors.push(format!("{}：{}", path.display(), error));
    }

    fn visit(&mut self, path: &Path, root: &Path, label: &str, ancestors: &mut HashSet<String>) {
        if excluded(path) {
            return;
        }
        let target = match dunce::canonicalize(path) {
            Ok(target) => target,
            Err(error) => {
                self.error(path, error);
                return;
            }
        };
        let id = key(&target);
        if excluded(&target) || ancestors.contains(&id) {
            return;
        }
        let file = path.join("SKILL.md");
        match fs::metadata(&file) {
            Ok(metadata) if metadata.is_file() => {
                let ((name, description, body, meta), digest) = match read_document(&file) {
                    Ok(text) => {
                        let parsed = document(&text);
                        let digest = if parsed.2.trim().is_empty() {
                            String::new()
                        } else {
                            crate::ai::digest(&text)
                        };
                        (parsed, digest)
                    }
                    Err(error) => {
                        self.error(&file, &error);
                        (
                            (
                                None,
                                String::new(),
                                format!("无法预览此文件：{error}"),
                                Meta::default(),
                            ),
                            String::new(),
                        )
                    }
                };
                let name = name.unwrap_or_else(|| {
                    path.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned()
                });
                self.skills.push(Skill {
                    display_name: format_skill_name(&name),
                    name,
                    directory: path.to_owned(),
                    linked: key(path) != id,
                    target,
                    root: root.to_owned(),
                    label: label.to_owned(),
                    description,
                    body,
                    digest,
                    repository: meta.repository,
                    version: meta.version,
                    lock_name: None,
                    // Use the discovered directory itself so each source (including
                    // junctions) has its own timestamp. Editing SKILL.md must not reset it.
                    installed_at: fs::symlink_metadata(path).ok()
                        .and_then(|metadata| metadata.created().ok())
                        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|duration| duration.as_millis() as u64),
                    modified_at: metadata.modified().ok()
                        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|duration| duration.as_millis() as u64),
                });
                return;
            }
            Err(error) if error.kind() != io::ErrorKind::NotFound => {
                self.error(&file, error);
                return;
            }
            _ => {}
        }
        let entries = match fs::read_dir(path) {
            Ok(entries) => entries,
            Err(error) => {
                self.error(path, error);
                return;
            }
        };
        ancestors.insert(id.clone());
        for entry in entries {
            match entry {
                Ok(entry) => {
                    let child = entry.path();
                    if excluded(&child) {
                        continue;
                    }
                    match fs::metadata(&child) {
                        Ok(meta) if meta.is_dir() => self.visit(&child, root, label, ancestors),
                        Ok(_) => {}
                        Err(error) => self.error(&child, error),
                    }
                }
                Err(error) => self.error(path, error),
            }
        }
        ancestors.remove(&id);
    }
}

pub fn scan(home: &Path) -> Inventory {
    let mut inventory = Inventory::default();
    let mut roots = BTreeMap::new();
    let mut add = |path: PathBuf, label: String| {
        roots.entry(key(&path)).or_insert((path, label));
    };
    for &tool in KNOWN {
        add(home.join(tool).join("skills"), tool.to_owned());
    }
    match fs::read_dir(home) {
        Ok(entries) => {
            for entry in entries {
                match entry {
                    Ok(entry) => {
                        let name = entry.file_name().to_string_lossy().into_owned();
                        if name.starts_with('.')
                            && !excluded(&entry.path())
                            && entry.path().is_dir()
                        {
                            add(entry.path().join("skills"), name);
                        }
                    }
                    Err(error) => inventory.error(home, error),
                }
            }
        }
        Err(error) => inventory.error(home, error),
    }
    for (var, relative) in [
        ("CODEX_HOME", "skills"),
        ("XDG_CONFIG_HOME", "opencode/skills"),
    ] {
        if let Some(base) = env::var_os(var)
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
        {
            add(base.join(relative), var.to_owned());
        }
    }
    for (root, label) in roots.values() {
        match fs::symlink_metadata(root) {
            Ok(_) => inventory.visit(root, root, label, &mut HashSet::new()),
            Err(error) if error.kind() != io::ErrorKind::NotFound => inventory.error(root, error),
            _ => {}
        }
    }
    inventory
        .skills
        .sort_by_cached_key(|s| (s.name.to_lowercase(), key(&s.directory)));
    let mut discovered = HashSet::new();
    inventory
        .skills
        .retain(|s| discovered.insert(key(&s.directory)));
    inventory.physical_count = inventory
        .skills
        .iter()
        .map(|s| key(&s.target))
        .collect::<HashSet<_>>()
        .len();
    let installed = crate::repository::installed(home);
    let managed = home.join(".agents/skills");
    for skill in &mut inventory.skills {
        let entry = [&skill.target, &skill.directory].into_iter().find_map(|path| {
            if path.parent() != Some(managed.as_path()) {
                return None;
            }
            installed.get_key_value(path.file_name()?.to_str()?)
        });
        skill.lock_name = entry
            .filter(|(_, entry)| entry.tracked.is_some())
            .map(|(name, _)| name.clone());
        if skill.repository.is_none() {
            skill.repository = entry
                .map(|(_, entry)| entry.url.clone())
                .or_else(|| crate::repository::origin(&skill.target));
        }
    }
    inventory
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_handles_crlf_bom_and_multiline_descriptions() {
        let text = "\u{feff}---\r\ndescription: >-\r\n  第一行\r\n  第二行\r\n---\r\n# 正文";
        assert_eq!(
            document(text),
            (None, "第一行 第二行".into(), "# 正文".into(), Meta::default())
        );
        assert_eq!(
            document("# 仅有正文"),
            (None, String::new(), "# 仅有正文".into(), Meta::default())
        );
    }

    #[test]
    fn versions_come_from_top_level_or_metadata_and_drop_the_v_prefix() {
        for (front, expected) in [
            ("version: 1.5.0", Some("1.5.0")),
            ("metadata:
  version: \"v1.6.1\"", Some("1.6.1")),
            ("metadata:
  version: 37", Some("37")),
            ("version: 1.2
metadata:
  version: 9", Some("1.2")),
            ("version: \"\"", None),
            ("version: not a version", None),
            ("name: x", None),
        ] {
            let text = format!("---
{front}
---
# 正文");
            assert_eq!(document(&text).3.version.as_deref(), expected, "{front}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn distinct_entries_share_one_target_and_cycles_do_not_recurse() {
        let fixture = tempfile::tempdir().unwrap();
        let home = fixture.path().join("home");
        let original = home.join(".agents").join("skills").join("pdf");
        let cursor = home.join(".cursor").join("skills");
        let alias = cursor.join("pdf");
        for dir in [&original, &cursor, &home.join(".codex/skills")] {
            fs::create_dir_all(dir).unwrap();
        }
        for dir in [
            &original,
            &original.join("example"),
            &cursor.join(".system/builtin"),
        ] {
            fs::create_dir_all(dir).unwrap();
            fs::write(
                dir.join("SKILL.md"),
                "---\ndescription: 读取 PDF\n---\n# PDF",
            )
            .unwrap();
        }
        for (link, target) in [(&alias, &original), (&cursor.join("loop"), &cursor)] {
            let made = std::process::Command::new("cmd.exe")
                .args(["/d", "/c", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .unwrap();
            assert!(
                made.status.success(),
                "mklink: {} {}",
                String::from_utf8_lossy(&made.stdout),
                String::from_utf8_lossy(&made.stderr)
            );
        }
        let report = scan(&home);
        let rows: Vec<_> = report
            .skills
            .iter()
            .filter(|s| s.root.starts_with(&home))
            .collect();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows.iter().filter(|s| s.linked).count(), 1);
        assert_eq!(rows[0].target, rows[1].target);
        assert_eq!(rows[0].description, "读取 PDF");
        assert!(rows.iter().any(|s| s.directory == alias && s.linked));
        fs::remove_file(original.join("SKILL.md")).unwrap();
        fs::remove_file(original.join("example/SKILL.md")).unwrap();
        assert!(scan(&home)
            .skills
            .iter()
            .all(|s| !s.root.starts_with(&home)));
    }

    #[test]
    fn skill_titles_format_the_frontmatter_name_or_directory() {
        let fixture = tempfile::tempdir().unwrap();
        let skill = fixture.path().join("directory-alias");
        fs::create_dir_all(skill.join("agents")).unwrap();
        let file = skill.join("SKILL.md");
        let config = skill.join("agents/openai.yaml");
        let scan_one = || {
            let mut inventory = Inventory::default();
            inventory.visit(&skill, fixture.path(), ".agents", &mut HashSet::new());
            inventory.skills.pop().unwrap()
        };
        fs::write(&file, "# Skill").unwrap();
        assert_eq!(scan_one().display_name, "Directory Alias");
        fs::write(
            &file,
            "---\nname: migrate-radix-to-base\n---\n# A different heading",
        )
        .unwrap();
        fs::write(&config, "interface:\n  display_name: 'ina-group 个人周报'").unwrap();
        let scanned = scan_one();
        assert_eq!(scanned.display_name, "Migrate Radix to Base");
        assert_eq!(scanned.name, "migrate-radix-to-base");
    }

    #[test]
    fn installation_time_uses_directory_creation_and_survives_document_updates() {
        let fixture = tempfile::tempdir().unwrap();
        let skill = fixture.path().join("example");
        fs::create_dir(&skill).unwrap();
        let expected = fs::symlink_metadata(&skill).unwrap().created().ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64);
        let scan_one = || {
            let mut inventory = Inventory::default();
            inventory.visit(&skill, fixture.path(), ".agents", &mut HashSet::new());
            inventory.skills.pop().unwrap()
        };
        fs::write(skill.join("SKILL.md"), "# Original").unwrap();
        assert_eq!(scan_one().installed_at, expected);
        fs::write(skill.join("SKILL.md"), "# Updated").unwrap();
        assert_eq!(scan_one().installed_at, expected);
    }

    #[test]
    fn resolves_declared_installed_and_git_sources_but_ignores_body_links() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let skills = home.join(".agents/skills");
        for (name, text) in [
            (
                "declared",
                "---\nmetadata:\n  openclaw:\n    homepage: https://github.com/org/declared\n---\n",
            ),
            ("installed", "# copy"),
            ("checkout", "# local"),
            ("unknown", "See https://github.com/org/unrelated"),
        ] {
            let dir = skills.join(name);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("SKILL.md"), text).unwrap();
        }
        fs::write(
            home.join(".agents/.skill-lock.json"),
            r#"{"skills":{"installed":{"sourceType":"github","source":"org/install"}}}"#,
        )
        .unwrap();
        let git = skills.join("checkout/.git");
        fs::create_dir(&git).unwrap();
        fs::write(
            git.join("config"),
            "[remote \"origin\"]\nurl = git@github.com:org/checkout.git",
        )
        .unwrap();
        let report = scan(home);
        for (name, expected) in [
            ("declared", Some("https://github.com/org/declared")),
            ("installed", Some("https://github.com/org/install")),
            ("checkout", Some("https://github.com/org/checkout")),
            ("unknown", None),
        ] {
            assert_eq!(
                report
                    .skills
                    .iter()
                    .find(|s| s.directory == skills.join(name))
                    .unwrap()
                    .repository
                    .as_deref(),
                expected
            );
        }
    }

    #[test]
    fn scan_skips_skills_in_projects_and_parent_directories() {
        let fixture = tempfile::tempdir().unwrap();
        let home = fixture.path().join("home");
        let user_skill = home.join(".agents/skills/personal");
        for path in [
            &user_skill,
            &home.join("work/demo/.agents/skills/project-only"),
            &fixture.path().join(".agents/skills/parent-only"),
        ] {
            fs::create_dir_all(path).unwrap();
            fs::write(path.join("SKILL.md"), "# Skill").unwrap();
        }
        let inventory = scan(&home);
        let discovered: Vec<_> = inventory
            .skills
            .iter()
            .filter(|s| s.directory.starts_with(fixture.path()))
            .map(|s| &s.directory)
            .collect();
        assert_eq!(discovered, vec![&user_skill]);
    }
}
