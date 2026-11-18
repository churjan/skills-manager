use reqwest::{Client, ClientBuilder, Proxy, Url};
use std::{net::IpAddr, time::Duration};

fn local_target(url: &Url) -> bool {
    let host = url.host_str().unwrap_or("").trim_matches(['[', ']']);
    host.eq_ignore_ascii_case("localhost")
        || host.ends_with(".localhost")
        || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

fn fixed_proxy(address: String) -> ClientBuilder {
    let proxy = Proxy::custom(move |url| (!local_target(url)).then(|| address.clone()));
    Client::builder().no_proxy().proxy(proxy)
}

fn pac_proxy_address(script: &str) -> Option<String> {
    script.split(['"', '\'', ';']).find_map(|part| {
        let mut words = part.split_whitespace();
        if !words.next()?.eq_ignore_ascii_case("PROXY") {
            return None;
        }
        let address = format!("http://{}", words.next()?);
        let url = Url::parse(&address).ok()?;
        (url.host_str().is_some()
            && url.port_or_known_default() != Some(0)
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none()
            && url.username().is_empty()
            && url.password().is_none())
        .then_some(address)
    })
}

#[cfg(windows)]
fn system_pac_url() -> Option<Url> {
    const ENV: [&str; 6] = [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ];
    if ENV
        .iter()
        .any(|name| std::env::var_os(name).is_some_and(|v| !v.is_empty()))
    {
        return None;
    }
    let Ok(key) = windows_registry::CURRENT_USER
        .open(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
    else {
        return None;
    };
    if key.get_u32("ProxyEnable").unwrap_or(0) != 0 {
        return None;
    }
    key.get_string("AutoConfigURL")
        .ok()
        .and_then(|url| Url::parse(url.trim()).ok())
        .filter(|url| matches!(url.scheme(), "http" | "https"))
}

#[cfg(not(windows))]
fn system_pac_url() -> Option<Url> {
    None
}

/// System proxy in PAC mode (e.g. Clash Verge): use the PAC's proxy for every request.
async fn pac_proxy(url: Url) -> Option<String> {
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .ok()?;
    let response = client.get(url).send().await.ok()?;
    pac_proxy_address(&response.error_for_status().ok()?.text().await.ok()?)
}

/// Always follow the system proxy; legacy network.json settings are no longer read.
pub async fn client_builder() -> Result<ClientBuilder, String> {
    if let Some(url) = system_pac_url() {
        if let Some(address) = pac_proxy(url).await {
            return Ok(fixed_proxy(address));
        }
    }
    Ok(Client::builder())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };

    #[test]
    fn extracts_first_http_proxy_from_pac() {
        let script = r#"function FindProxyForURL(url, host) {
  if (host === "git.local" || shExpMatch(host, "192.168.88.*")) {
    return "DIRECT";
  }
  return "PROXY 127.0.0.1:7897; SOCKS5 127.0.0.1:7897; DIRECT;";
}"#;
        assert_eq!(
            pac_proxy_address(script).as_deref(),
            Some("http://127.0.0.1:7897")
        );
        assert_eq!(pac_proxy_address("return 'DIRECT';"), None);
        assert_eq!(pac_proxy_address("return 'PROXY a/b:1';"), None);
    }

    #[test]
    fn bypasses_loopback_only() {
        for target in ["http://localhost:1234", "http://127.0.0.2", "http://[::1]"] {
            assert!(local_target(&Url::parse(target).unwrap()));
        }
        for target in ["https://github.com", "http://localhost.example.com"] {
            assert!(!local_target(&Url::parse(target).unwrap()));
        }
    }

    #[test]
    fn sends_external_requests_through_explicit_proxy() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut byte = [0];
            while !bytes.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                bytes.push(byte[0]);
            }
            assert!(String::from_utf8(bytes)
                .unwrap()
                .starts_with("GET http://proxy-test.invalid/test HTTP/1.1"));
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
        });
        tauri::async_runtime::block_on(async {
            let client = fixed_proxy(format!("http://127.0.0.1:{port}"))
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap();
            assert_eq!(
                client
                    .get("http://proxy-test.invalid/test")
                    .send()
                    .await
                    .unwrap()
                    .text()
                    .await
                    .unwrap(),
                "ok"
            );
        });
        server.join().unwrap();
    }
}
