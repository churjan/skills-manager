#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod inventory;
mod network;
mod repository;
mod repository_search;

use inventory::{scan, Inventory};
use std::{collections::HashMap, env, path::PathBuf, process::Command, sync::Mutex};
use tauri::{AppHandle, Manager};

#[derive(Default)]
struct Session {
    targets: Mutex<HashMap<PathBuf, PathBuf>>,
}

#[tauri::command]
async fn scan_skills(app: AppHandle) -> Result<Inventory, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = app.state::<Session>();
        let home = dirs::home_dir().ok_or("无法定位用户目录")?;
        let mut result = scan(&home);
        if result.errors.is_empty() {
            if let Err(message) = ai::prune_skill_caches(&result.skills) {
                result.errors.push(format!("无法清理技能缓存：{message}"));
            }
        }
        repository_search::apply_cached_repositories(&mut result.skills);
        *session.targets.lock().map_err(|e| e.to_string())? = result
            .skills
            .iter()
            .map(|skill| (skill.directory.clone(), skill.target.clone()))
            .collect();
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn open_directory(directory: PathBuf, app: AppHandle) -> Result<(), String> {
    let session = app.state::<Session>();
    let expected = session
        .targets
        .lock()
        .map_err(|e| e.to_string())?
        .get(&directory)
        .cloned()
        .ok_or("目录已变更，请刷新")?;
    let target = dunce::canonicalize(directory).map_err(|e| e.to_string())?;
    if target != expected || !target.is_dir() {
        return Err("目录已变更，请刷新".into());
    }
    let explorer =
        PathBuf::from(env::var_os("SystemRoot").ok_or("找不到 Windows 目录")?).join("explorer.exe");
    Command::new(explorer)
        .arg(target)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_github_repository(url: String) -> Result<(), String> {
    if repository::github_url(&url).as_deref() != Some(url.as_str()) {
        return Err("无效的 GitHub 仓库地址".into());
    }
    open_url(&url)
}

/// Open a validated https address in the default browser.
fn open_url(url: &str) -> Result<(), String> {
    let explorer =
        PathBuf::from(env::var_os("SystemRoot").ok_or("找不到 Windows 目录")?).join("explorer.exe");
    Command::new(explorer)
        .arg(url)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(Session::default())
        .invoke_handler(tauri::generate_handler![
            scan_skills,
            open_directory,
            open_github_repository,
            repository_search::find_github_repository,
            repository_search::load_repository_lookups,
            repository_search::updates::check_skill_updates,
            repository_search::updates::open_skill_changes,
            ai::config::ai_settings,
            ai::config::read_ai_model,
            ai::config::save_ai_model,
            ai::config::remove_ai_model,
            ai::config::save_ai_preferences,
            ai::test_ai_settings,
            ai::load_summaries,
            ai::generate_summary
        ])
        .run(tauri::generate_context!())
        .expect("Skill 管理窗口启动失败");
}
