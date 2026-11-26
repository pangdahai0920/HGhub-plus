//! 会话持久化：token + 用户资料存到应用数据目录。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Session {
    // 旧版本没有 origin：不能推断其 token 属于哪个镜像，升级后必须重新登录。
    #[serde(default)]
    pub origin: String,
    /// 只留在内存和单独的 0600 文件里，绝不再写进 session.json（旧版本写在里面，bind 时会迁移出去）
    #[serde(default, skip_serializing)]
    pub token: String,
    #[serde(default)]
    pub user: serde_json::Value,
}

/// token 与用户资料分文件存：session.json 可能被用户拿去反馈/备份，不该带着凭据
const TOKEN_FILE: &str = "session.token";

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn credentials_are_bound_to_origin() {
        let store = SessionStore::new();
        store.set(
            "https://huangguoai.com",
            "secret-token".into(),
            json!({"id": 1}),
        );
        assert_eq!(
            store.token("https://huangguoai.com").as_deref(),
            Some("secret-token")
        );
        assert_eq!(store.token("https://huangguoai.ai"), None);
        assert_eq!(store.token("https://evil.example"), None);
        assert!(store.user("https://evil.example").is_null());
        store.clear();
        assert_eq!(store.token("https://huangguoai.com"), None);
    }

    #[test]
    fn legacy_sessions_are_not_assigned_to_current_line() {
        let store = SessionStore::new();
        *store.current.lock().unwrap() =
            serde_json::from_str(r#"{"token":"legacy","user":{"id":1}}"#).unwrap();
        assert_eq!(store.token("https://huangguoai.com"), None);
        assert!(store.user("https://huangguoai.com").is_null());
    }

    #[test]
    fn session_is_persisted_atomically() {
        let dir = std::env::temp_dir().join(format!("hghub-session-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let store = SessionStore::new();
        store.bind(dir.clone());
        store.set("https://a.example", "t1".into(), json!({"id": 1}));

        let file = dir.join("session.json");
        assert!(std::fs::read_to_string(&file).unwrap().contains("a.example"));
        assert!(!dir.join("session.json.tmp").exists(), "临时文件必须被 rename 掉");
        assert!(!dir.join("session.token.tmp").exists());

        // 重新绑定后能读回，说明落盘的是完整 JSON
        let again = SessionStore::new();
        again.bind(dir.clone());
        assert_eq!(again.token("https://a.example").as_deref(), Some("t1"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn token_never_lands_in_the_plain_json() {
        let dir = std::env::temp_dir().join(format!("hghub-token-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let store = SessionStore::new();
        store.bind(dir.clone());
        store.set("https://a.example", "secret-1".into(), json!({"id": 1}));

        let json = std::fs::read_to_string(dir.join("session.json")).unwrap();
        assert!(!json.contains("secret-1"), "session.json 里不该出现 token：{json}");
        assert_eq!(std::fs::read_to_string(dir.join("session.token")).unwrap(), "secret-1");

        // 退出登录把 token 文件删掉
        store.clear();
        assert!(!dir.join("session.token").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_token_inside_json_is_migrated_out() {
        let dir = std::env::temp_dir().join(format!("hghub-legacy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("session.json"),
            r#"{"origin":"https://a.example","token":"legacy-1","user":{"id":1}}"#,
        )
        .unwrap();

        let store = SessionStore::new();
        store.bind(dir.clone());
        assert_eq!(store.token("https://a.example").as_deref(), Some("legacy-1"));
        assert!(!std::fs::read_to_string(dir.join("session.json")).unwrap().contains("legacy-1"));
        assert_eq!(std::fs::read_to_string(dir.join("session.token")).unwrap(), "legacy-1");

        let _ = std::fs::remove_dir_all(&dir);
    }
}

pub struct SessionStore {
    pub file: Mutex<Option<PathBuf>>,
    pub current: Mutex<Session>,
}

impl SessionStore {
    pub fn new() -> Self {
        Self {
            file: Mutex::new(None),
            current: Mutex::new(Session::default()),
        }
    }

    pub fn bind(&self, dir: PathBuf) {
        let path = dir.join("session.json");
        let token_path = path.with_file_name(TOKEN_FILE);

        let mut sess = Session::default();
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(parsed) = serde_json::from_str::<Session>(&text) {
                sess = parsed;
            }
        }
        /* token 单独一个文件（Unix 下 0600）；旧版本写在 session.json 里，这里顺手迁移出去 */
        let from_file = std::fs::read_to_string(&token_path)
            .ok()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());
        let legacy = (!sess.token.is_empty()).then(|| sess.token.clone());
        if let Some(token) = from_file.or_else(|| legacy.clone()) {
            sess.token = token;
        }
        *self.current.lock().unwrap() = sess;
        *self.file.lock().unwrap() = Some(path);
        if legacy.is_some() {
            self.persist();   // 立刻重写 session.json，把明文 token 抹掉
        }
    }

    pub fn token(&self, origin: &str) -> Option<String> {
        let cur = self.current.lock().unwrap();
        (cur.origin == origin && !cur.token.is_empty()).then(|| cur.token.clone())
    }

    pub fn user(&self, origin: &str) -> serde_json::Value {
        let cur = self.current.lock().unwrap();
        if cur.origin == origin && !cur.token.is_empty() {
            cur.user.clone()
        } else {
            serde_json::Value::Null
        }
    }

    pub fn set(&self, origin: &str, token: String, user: serde_json::Value) {
        {
            let mut cur = self.current.lock().unwrap();
            cur.origin = origin.to_string();
            cur.token = token;
            cur.user = user;
        }
        self.persist();
    }

    pub fn clear(&self) {
        {
            let mut cur = self.current.lock().unwrap();
            cur.token.clear();
            cur.origin.clear();
            cur.user = serde_json::Value::Null;
        }
        self.persist();
    }

    fn persist(&self) {
        let snapshot = self.current.lock().unwrap().clone();
        let path = self.file.lock().unwrap().clone();
        if let Some(path) = path {
            /* Session 的 token 字段是 skip_serializing，写出去的 JSON 只有 origin + user */
            if let Ok(text) = serde_json::to_string_pretty(&snapshot) {
                write_atomic(&path, text.as_bytes());
            }
            let token_path = path.with_file_name(TOKEN_FILE);
            if snapshot.token.is_empty() {
                let _ = std::fs::remove_file(&token_path);
            } else {
                write_atomic(&token_path, snapshot.token.as_bytes());
            }
        }
    }
}

/// 先写临时文件再原子替换：直接 `fs::write` 中途崩溃/磁盘满会留下半截 session.json，
/// 下次启动解析失败就表现为「随机掉登录」，而且旧会话也一起丢了。
fn write_atomic(path: &std::path::Path, bytes: &[u8]) {
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, bytes).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return;
    }
    if std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return;
    }
    restrict_permissions(path);
}

/// token 等价于账号凭据：Unix 下把文件收紧到仅本人可读写（Windows 由用户配置目录的 ACL 保证）。
#[cfg(unix)]
fn restrict_permissions(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &std::path::Path) {}
