//! Restricts the API to the local machine.
//!
//! The API has no auth of its own, and `GET /api/telegram/transfer` returns
//! the Telegram session. Binding to loopback keeps the LAN out; this guard
//! keeps other websites out too, by rejecting DNS-rebinding (`Host`) and
//! cross-site requests (`Origin`).

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use http::{header, HeaderMap, StatusCode, Uri};

pub async fn guard(request: Request, next: Next) -> Response {
    if is_local(request.headers()) {
        next.run(request).await
    } else {
        StatusCode::FORBIDDEN.into_response()
    }
}

fn is_local(headers: &HeaderMap) -> bool {
    let host_ok = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .is_some_and(is_loopback);
    let origin_ok = match headers.get(header::ORIGIN) {
        None => true,
        Some(origin) => origin.to_str().is_ok_and(is_loopback),
    };
    host_ok && origin_ok
}

fn is_loopback(value: &str) -> bool {
    value.parse::<Uri>().is_ok_and(|uri| {
        matches!(uri.host(), Some("localhost" | "127.0.0.1" | "[::1]"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(host: &str, origin: Option<&str>) -> bool {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, host.parse().unwrap());
        if let Some(origin) = origin {
            headers.insert(header::ORIGIN, origin.parse().unwrap());
        }
        is_local(&headers)
    }

    #[test]
    fn accepts_loopback() {
        assert!(check("localhost:5173", None));
        assert!(check("127.0.0.1:9811", Some("http://localhost:5173")));
        assert!(check("[::1]:9811", None));
    }

    #[test]
    fn rejects_rebinding_and_cross_site_requests() {
        assert!(!check("evil.example:9811", None));
        assert!(!check("localhost.evil.example", None));
        assert!(!check("localhost:9811", Some("https://evil.example")));
        assert!(!check("localhost:9811", Some("null")));
        assert!(!is_local(&HeaderMap::new()));
    }
}
