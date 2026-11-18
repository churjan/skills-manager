use super::{data_dir, endpoint, lock_file, read_json, write_json, ModelConfig, SETTINGS};
use serde::{Deserialize, Serialize};
use std::path::Path;
use uuid::Uuid;

#[derive(Serialize, Deserialize)]
struct SavedModel {
    id: String,
    #[serde(flatten)]
    config: ModelConfig,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    models: Vec<SavedModel>,
    active_model: Option<String>,
    auto_generate: bool,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum OnDisk {
    Current(Config),
    Legacy {
        #[serde(flatten)]
        model: ModelConfig,
        #[serde(default, rename = "autoGenerate")]
        auto_generate: bool,
    },
}

impl Default for OnDisk {
    fn default() -> Self {
        Self::Current(Config::default())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    id: String,
    model: String,
    base_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    models: Vec<ModelInfo>,
    active_model: Option<String>,
    auto_generate: bool,
}

impl Config {
    fn view(self) -> SettingsView {
        SettingsView {
            models: self
                .models
                .into_iter()
                .map(|m| ModelInfo {
                    id: m.id,
                    model: m.config.model,
                    base_url: m.config.base_url,
                })
                .collect(),
            active_model: self.active_model,
            auto_generate: self.auto_generate,
        }
    }
}

fn load(dir: &Path) -> Result<Config, String> {
    match read_json(dir, SETTINGS)? {
        OnDisk::Current(config) => Ok(config),
        OnDisk::Legacy {
            model,
            auto_generate,
        } => {
            if model.base_url.is_empty() && model.model.is_empty() && model.api_key.is_empty() {
                return Ok(Config::default());
            }
            let id = "previous-model".to_owned();
            Ok(Config {
                active_model: Some(id.clone()),
                models: vec![SavedModel { id, config: model }],
                auto_generate,
            })
        }
    }
}

fn update(
    dir: &Path,
    change: impl FnOnce(&mut Config) -> Result<(), String>,
) -> Result<SettingsView, String> {
    let _lock = lock_file(dir, "settings.lock")?;
    let mut config = load(dir)?;
    change(&mut config)?;
    write_json(dir, SETTINGS, &config)?;
    Ok(config.view())
}

pub(super) fn active_config(dir: &Path) -> Result<ModelConfig, String> {
    let config = load(dir)?;
    config
        .models
        .into_iter()
        .find(|m| Some(&m.id) == config.active_model.as_ref())
        .map(|m| m.config)
        .ok_or_else(|| "请在设置中选择用于简介的模型".into())
}

#[tauri::command]
pub fn ai_settings() -> Result<SettingsView, String> {
    Ok(load(&data_dir()?)?.view())
}

pub(super) fn auto_generate_enabled(dir: &Path) -> Result<bool, String> {
    Ok(load(dir)?.auto_generate)
}

#[tauri::command]
pub fn read_ai_model(id: String) -> Result<ModelConfig, String> {
    load(&data_dir()?)?
        .models
        .into_iter()
        .find(|m| m.id == id)
        .map(|m| m.config)
        .ok_or_else(|| "这个模型已被移除".into())
}

pub(super) fn upsert(
    dir: &Path,
    id: Option<String>,
    mut model: ModelConfig,
) -> Result<SettingsView, String> {
    let url = endpoint(&model)?;
    model.model = model.model.trim().to_owned();
    model.base_url = model.base_url.trim().trim_end_matches('/').to_owned();
    update(dir, |config| {
        if config.models.iter().any(|m| {
            Some(&m.id) != id.as_ref()
                && m.config.model == model.model
                && endpoint(&m.config).ok().as_ref() == Some(&url)
        }) {
            return Err("此服务商的这个模型已添加，可以在列表中编辑".into());
        }
        if let Some(id) = id {
            let existing = config
                .models
                .iter_mut()
                .find(|m| m.id == id)
                .ok_or("这个模型已被移除")?;
            existing.config = model;
        } else {
            let id = Uuid::new_v4().to_string();
            if config.models.is_empty() {
                config.active_model = Some(id.clone());
            }
            config.models.push(SavedModel { id, config: model });
        }
        Ok(())
    })
}

#[tauri::command]
pub fn save_ai_model(id: Option<String>, model: ModelConfig) -> Result<SettingsView, String> {
    upsert(&data_dir()?, id, model)
}

#[tauri::command]
pub fn remove_ai_model(id: String) -> Result<SettingsView, String> {
    update(&data_dir()?, |config| {
        let index = config
            .models
            .iter()
            .position(|m| m.id == id)
            .ok_or("这个模型已被移除")?;
        config.models.remove(index);
        if config.active_model.as_ref() == Some(&id) {
            config.active_model = None;
            config.auto_generate = false;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn save_ai_preferences(
    active_model: Option<String>,
    auto_generate: bool,
) -> Result<SettingsView, String> {
    let dir = data_dir()?;
    let view = update(&dir, |config| {
        if let Some(id) = &active_model {
            if !config.models.iter().any(|m| &m.id == id) {
                return Err("所选模型已被移除".into());
            }
        } else if auto_generate {
            return Err("请先选择生成简介使用的模型".into());
        }
        config.active_model = active_model;
        config.auto_generate = auto_generate;
        Ok(())
    })?;
    if !auto_generate {
        super::clear_summaries(&dir)?;
    }
    Ok(view)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_github_preference_is_dropped_from_settings() {
        let config: Config = serde_json::from_value(serde_json::json!({
            "models": [{"id":"saved","model":"mock","baseUrl":"https://a.example","apiKey":"fixture"}],
            "activeModel":"saved", "autoGenerate":false, "showGithub":false
        }))
        .unwrap();
        let view = config.view();
        assert!(!view.auto_generate);
        assert!(serde_json::to_value(view).unwrap().get("showGithub").is_none());
    }

    #[test]
    fn adding_another_model_preserves_legacy_key_selection_and_preferences() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();
        write_json(dir, SETTINGS, &serde_json::json!({"baseUrl":"https://a.example","model":"first","apiKey":"old-key","autoGenerate":true})).unwrap();
        let view = upsert(
            dir,
            None,
            ModelConfig {
                base_url: "https://b.example".into(),
                model: "second".into(),
                api_key: "new-key".into(),
            },
        )
        .unwrap();
        assert_eq!(view.models.len(), 2);
        assert!(view.auto_generate);
        assert_eq!(active_config(dir).unwrap().api_key, "old-key");
        let id = view.models[1].id.clone();
        update(dir, |c| {
            c.active_model = Some(id);
            Ok(())
        })
        .unwrap();
        assert_eq!(active_config(dir).unwrap().api_key, "new-key");
        assert!(!serde_json::to_string(&load(dir).unwrap().view())
            .unwrap()
            .contains("new-key"));
    }
}
