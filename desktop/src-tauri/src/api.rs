use std::time::Duration;

use anyhow::{bail, Context, Result};
use reqwest::{Client, Method, StatusCode};
use serde::de::DeserializeOwned;
use serde::Serialize;
use url::Url;
use zeroize::Zeroizing;

use crate::storage;

#[derive(Clone)]
pub struct ApiClient {
    client: Client,
    origin: Url,
}

impl ApiClient {
    pub fn new(origin: &str) -> Result<Self> {
        let origin = Url::parse(origin).context("parsing SPAWN D server origin")?;
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .user_agent(concat!("SPAWN-D-desktop/", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(Self { client, origin })
    }

    pub fn origin(&self) -> &Url {
        &self.origin
    }

    pub fn url(&self, path: &str) -> Result<Url> {
        self.origin
            .join(path)
            .context("constructing SPAWN D API URL")
    }

    pub fn raw_client(&self) -> &Client {
        &self.client
    }

    pub async fn anonymous_json<T: DeserializeOwned, B: Serialize>(
        &self,
        method: Method,
        path: &str,
        body: &B,
    ) -> Result<T> {
        self.send_json(method, path, body, None).await
    }

    pub async fn authenticated_json<T: DeserializeOwned, B: Serialize>(
        &self,
        method: Method,
        path: &str,
        body: &B,
    ) -> Result<T> {
        let token = storage::token(self.origin.as_str().trim_end_matches('/'))?;
        self.send_json(method, path, body, Some(&token)).await
    }

    /// The status a path answers with, treating a non-2xx as an answer rather
    /// than a failure — for asking whether a server has an endpoint at all.
    pub async fn probe(&self, method: Method, path: &str) -> Result<reqwest::StatusCode> {
        let response = self
            .client
            .request(method, self.url(path)?)
            .send()
            .await
            .context("reaching the SPAWN D server")?;
        Ok(response.status())
    }

    pub async fn anonymous_get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        self.send::<T>(self.client.get(self.url(path)?)).await
    }

    /// A POST whose success is `204 No Content`; only a failure carries a body.
    pub async fn authenticated_post_no_content(&self, path: &str) -> Result<()> {
        let token = storage::token(self.origin.as_str().trim_end_matches('/'))?;
        let response = self
            .client
            .post(self.url(path)?)
            .bearer_auth(token.as_str())
            .send()
            .await
            .context("reaching the SPAWN D server")?;
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        let bytes = response
            .bytes()
            .await
            .context("reading the SPAWN D response")?;
        bail!("{}", error_detail(status, &bytes))
    }

    /// A POST whose response headers matter as much as its body — the one
    /// place that is the session renewal, whose `Set-Cookie` seeds the app
    /// window.
    pub async fn authenticated_post_with_headers<T: DeserializeOwned>(
        &self,
        path: &str,
    ) -> Result<(T, reqwest::header::HeaderMap)> {
        let token = storage::token(self.origin.as_str().trim_end_matches('/'))?;
        let response = self
            .client
            .post(self.url(path)?)
            .bearer_auth(token.as_str())
            .send()
            .await
            .context("reaching the SPAWN D server")?;
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response
            .bytes()
            .await
            .context("reading the SPAWN D response")?;
        if !status.is_success() {
            bail!("{}", error_detail(status, &bytes))
        }
        let body = serde_json::from_slice(&bytes).context("decoding the SPAWN D response")?;
        Ok((body, headers))
    }

    pub async fn authenticated_get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        let token = storage::token(self.origin.as_str().trim_end_matches('/'))?;
        self.send::<T>(self.client.get(self.url(path)?).bearer_auth(token.as_str()))
            .await
    }

    pub async fn authenticated_post<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        let token = storage::token(self.origin.as_str().trim_end_matches('/'))?;
        self.send::<T>(
            self.client
                .post(self.url(path)?)
                .bearer_auth(token.as_str()),
        )
        .await
    }

    async fn send_json<T: DeserializeOwned, B: Serialize>(
        &self,
        method: Method,
        path: &str,
        body: &B,
        token: Option<&Zeroizing<String>>,
    ) -> Result<T> {
        let mut request = self.client.request(method, self.url(path)?).json(body);
        if let Some(token) = token {
            request = request.bearer_auth(token.as_str());
        }
        self.send(request).await
    }

    async fn send<T: DeserializeOwned>(&self, request: reqwest::RequestBuilder) -> Result<T> {
        let response = request
            .send()
            .await
            .context("reaching the SPAWN D server")?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .context("reading the SPAWN D response")?;
        if !status.is_success() {
            bail!("{}", error_detail(status, &bytes))
        }
        serde_json::from_slice(&bytes).context("decoding the SPAWN D response")
    }

    pub async fn optional_authenticated_get(
        &self,
        path: &str,
    ) -> Result<Option<serde_json::Value>> {
        let token = storage::token(self.origin.as_str().trim_end_matches('/'))?;
        let response = self
            .client
            .get(self.url(path)?)
            .bearer_auth(token.as_str())
            .send()
            .await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let status = response.status();
        let bytes = response.bytes().await?;
        if !status.is_success() {
            bail!("SPAWN D server returned HTTP {status}")
        }
        Ok(Some(serde_json::from_slice(&bytes)?))
    }
}

/// The server's own words for a failure, so the window can show the same
/// message the browser would. A rate limit is the one status the wizard
/// treats differently from every other refusal, so it stays recognisable.
fn error_detail(status: StatusCode, bytes: &[u8]) -> String {
    let detail = serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()
        .and_then(|value| value.get("detail").cloned())
        .map(|value| match value {
            serde_json::Value::String(text) => text,
            // A refusal the server states as a machine code and some numbers
            // rather than as prose — the billing ones. It does that precisely
            // so the client owns every word a person reads, and the code is the
            // whole of what it means; rendering the raw JSON object would put
            // `{"code":"host_limit","tier":…}` on screen.
            serde_json::Value::Object(ref fields) => fields
                .get("code")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| value.to_string()),
            other => other.to_string(),
        })
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| {
            let raw = String::from_utf8_lossy(bytes).trim().to_owned();
            if raw.is_empty() {
                format!("SPAWN D server returned HTTP {status}")
            } else {
                raw
            }
        });
    if status == StatusCode::TOO_MANY_REQUESTS {
        format!("too many requests: {detail}")
    } else {
        detail
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_prose_detail_is_shown_as_the_server_wrote_it() {
        let seen = error_detail(
            StatusCode::FORBIDDEN,
            br#"{"detail": "that invite has been used"}"#,
        );
        assert_eq!(seen, "that invite has been used");
    }

    #[test]
    fn a_structured_refusal_reads_as_its_machine_code() {
        // `POST /api/auth/device/approve` refuses a host past the account's
        // limit with a code and three numbers, deliberately carrying no prose:
        // the wizard writes the sentence, from the code.
        let seen = error_detail(
            StatusCode::PAYMENT_REQUIRED,
            br#"{"detail": {"code": "host_limit", "tier": "free", "host_limit": 1, "host_count": 1}}"#,
        );
        assert_eq!(seen, "host_limit");
    }

    #[test]
    fn a_rate_limit_stays_recognisable() {
        let seen = error_detail(StatusCode::TOO_MANY_REQUESTS, br#"{"detail": "slow down"}"#);
        assert_eq!(seen, "too many requests: slow down");
    }

    #[test]
    fn a_body_with_no_detail_at_all_still_says_something() {
        let seen = error_detail(StatusCode::BAD_GATEWAY, b"");
        assert!(seen.contains("502"), "unexpected: {seen}");
    }
}
