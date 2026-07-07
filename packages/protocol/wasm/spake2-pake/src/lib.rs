use spake2::{Ed25519Group, Identity, Password, Spake2};
use wasm_bindgen::prelude::*;

fn initiator_identity(session_id: &str) -> Identity {
    Identity::new(format!("agentpair:{session_id}:initiator").as_bytes())
}

fn joiner_identity(session_id: &str) -> Identity {
    Identity::new(format!("agentpair:{session_id}:joiner").as_bytes())
}

#[wasm_bindgen]
pub struct PakeSession {
    state: Spake2<Ed25519Group>,
    outbound_message: Vec<u8>,
}

#[wasm_bindgen]
impl PakeSession {
    #[wasm_bindgen(js_name = startInitiator)]
    pub fn start_initiator(pairing_code: &str, session_id: &str) -> Result<PakeSession, JsValue> {
        let password = Password::new(pairing_code.as_bytes());
        let id_a = initiator_identity(session_id);
        let id_b = joiner_identity(session_id);
        let (state, outbound_message) =
            Spake2::<Ed25519Group>::start_a(&password, &id_a, &id_b);
        Ok(PakeSession {
            state,
            outbound_message,
        })
    }

    #[wasm_bindgen(js_name = startJoiner)]
    pub fn start_joiner(pairing_code: &str, session_id: &str) -> Result<PakeSession, JsValue> {
        let password = Password::new(pairing_code.as_bytes());
        let id_a = initiator_identity(session_id);
        let id_b = joiner_identity(session_id);
        let (state, outbound_message) =
            Spake2::<Ed25519Group>::start_b(&password, &id_a, &id_b);
        Ok(PakeSession {
            state,
            outbound_message,
        })
    }

    #[wasm_bindgen(js_name = outboundMessage)]
    pub fn outbound_message(&self) -> Vec<u8> {
        self.outbound_message.clone()
    }

    #[wasm_bindgen]
    pub fn finish(self, peer_message: &[u8]) -> Result<Vec<u8>, JsValue> {
        self.state
            .finish(peer_message)
            .map_err(|err| JsValue::from_str(&format!("SPAKE2 finish failed: {err}")))
    }
}
