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
            let detail = serde_json::from_slice::<serde_json::Value>(&bytes)
                .ok()
                .and_then(|value| value.get("detail").cloned())
                .map(|value| match value {
                    serde_json::Value::String(text) => text,
                    other => other.to_string(),
                })
                .unwrap_or_else(|| String::from_utf8_lossy(&bytes).into_owned());
            bail!("{detail}")
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
