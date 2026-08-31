use std::collections::HashMap;

use anyhow::{Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use reqwest::Method;
use serde_json::json;
use tokio::sync::Mutex;

use crate::api::ApiClient;
use crate::crypto::{
    ceremony_number, commitment_opens, verify_account_endorsement, DeviceIdentity,
};
use crate::models::{AccountEndorsement, DeviceApprovalProgress, PairingState};
use crate::storage;

#[derive(Default)]
pub struct DeviceCeremonies {
    nonces: Mutex<HashMap<String, [u8; 32]>>,
}

impl DeviceCeremonies {
    pub async fn poll(&self) -> Result<DeviceApprovalProgress> {
        let preferences = storage::load_preferences()?;
        if preferences.device_approved {
            return Ok(DeviceApprovalProgress::Approved);
        }
        let origin = &preferences.server_origin;
        let account_id = preferences
            .account_id
            .context("Sign in before approving this device")?;
        let device_id = preferences
            .device_id
            .context("Device registration is unavailable")?;
        let identity = DeviceIdentity::load_or_create(&account_id)?;
        let public_key = identity.public_key_wire();
        let api = ApiClient::new(origin)?;
        let pairings: Vec<PairingState> = api
            .authenticated_get(&format!(
                "/api/trust/pairing?device_id={}",
                url::form_urlencoded::byte_serialize(device_id.as_bytes()).collect::<String>()
            ))
            .await?;
        let Some(pairing) = pairings
            .into_iter()
            .find(|row| row.joiner_device_id == device_id)
        else {
            return Ok(DeviceApprovalProgress::Waiting);
        };
        if pairing
            .joiner_public_key
            .as_deref()
            .is_some_and(|key| key != public_key)
        {
            return Ok(refused("The other device's key changed during the check, so nothing was trusted. Start over."));
        }
        let nonce = {
            let mut nonces = self.nonces.lock().await;
            if let Some(existing) = nonces.get(&pairing.id) {
                *existing
            } else {
                let mut fresh = [0_u8; 32];
                getrandom::getrandom(&mut fresh).context("generating the number-check nonce")?;
                nonces.insert(pairing.id.clone(), fresh);
                fresh
            }
        };
        let nonce_wire = URL_SAFE_NO_PAD.encode(nonce);
        if pairing.joiner_nonce.is_none() {
            let _: PairingState = api
                .authenticated_json(
                    Method::POST,
                    &format!("/api/trust/pairing/{}/contribute", pairing.id),
                    &json!({ "joiner_public_key": public_key, "joiner_nonce": nonce_wire }),
                )
                .await?;
            return Ok(DeviceApprovalProgress::Waiting);
        }
        if pairing.joiner_nonce.as_deref() != Some(nonce_wire.as_str()) {
            return Ok(refused("The other device's key changed during the check, so nothing was trusted. Start over."));
        }
        let Some(initiator_nonce) = pairing.initiator_nonce.as_deref() else {
            return Ok(DeviceApprovalProgress::Waiting);
        };
        if !commitment_opens(
            &pairing.initiator_commit,
            &pairing.initiator_public_key,
            initiator_nonce,
        )? {
            return Ok(refused("The other device's key changed during the check, so nothing was trusted. Start over."));
        }
        let number = ceremony_number(
            &pairing.initiator_public_key,
            &public_key,
            initiator_nonce,
            &nonce_wire,
        )?;

        let edges: Vec<AccountEndorsement> = api
            .authenticated_get("/api/trust/account-endorsements")
            .await?;
        if let Some(edge) = edges.iter().find(|edge| {
            edge.endorser_device_id == pairing.initiator_device_id
                && edge.endorsed_device_id == device_id
        }) {
            if edge.endorser_public_key != pairing.initiator_public_key
                || edge.endorsed_public_key != public_key
            {
                return Ok(refused("The other device's key changed during the check, so nothing was trusted. Start over."));
            }
            verify_account_endorsement(
                &account_id,
                &edge.endorser_public_key,
                &edge.endorsed_public_key,
                &device_id,
                &edge.signature,
            )
            .context("the approving device's endorsement did not verify")?;
            let signature = identity.account_endorsement(
                &account_id,
                &pairing.initiator_public_key,
                &pairing.initiator_device_id,
            )?;
            let _: serde_json::Value = api
                .authenticated_json(
                    Method::POST,
                    "/api/trust/account-endorsements",
                    &json!({
                        "endorser_device_id": device_id,
                        "endorsed_device_id": pairing.initiator_device_id,
                        "signature": signature
                    }),
                )
                .await?;
            let mut preferences = storage::load_preferences()?;
            preferences.device_approved = true;
            storage::save_preferences(&preferences)?;
            self.nonces.lock().await.remove(&pairing.id);
            return Ok(DeviceApprovalProgress::Approved);
        }
        Ok(DeviceApprovalProgress::ShowNumber {
            pairing_id: pairing.id,
            number,
        })
    }
}

fn refused(message: &str) -> DeviceApprovalProgress {
    DeviceApprovalProgress::Refused {
        message: message.into(),
    }
}

pub async fn raise_knock() -> Result<()> {
    let preferences = storage::load_preferences()?;
    let device_id = preferences
        .device_id
        .context("Device registration is unavailable")?;
    let api = ApiClient::new(&preferences.server_origin)?;
    let _: serde_json::Value = api
        .authenticated_json(
            Method::POST,
            "/api/trust/device-approvals",
            &json!({ "browser_device_id": device_id }),
        )
        .await?;
    Ok(())
}
