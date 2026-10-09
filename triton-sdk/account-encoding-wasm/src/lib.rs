use {
    base64::{prelude::BASE64_STANDARD, Engine},
    serde::{de::Error as DeError, Deserialize, Deserializer, Serialize},
    solana_account::Account,
    solana_account_decoder::{
        encode_ui_account,
        parse_account_data::{AccountAdditionalDataV3, SplTokenAdditionalDataV2},
        parse_token::{get_token_account_mint, is_known_spl_token_id},
    },
    solana_account_decoder_client_types::{UiAccountData, UiAccountEncoding, UiDataSliceConfig},
    solana_pubkey::Pubkey,
    spl_token_2022_interface::{
        extension::{
            interest_bearing_mint::InterestBearingConfig, scaled_ui_amount::ScaledUiAmountConfig,
            BaseStateWithExtensions, StateWithExtensions,
        },
        state::Mint,
    },
    std::str::FromStr,
    wasm_bindgen::prelude::*,
};

#[wasm_bindgen]
#[derive(Clone, Copy, Debug)]
pub enum WasmUiAccountEncoding {
    Binary = 0,
    Base58 = 1,
    Base64 = 2,
    JsonParsed = 3,
    Base64Zstd = 4,
}

impl From<WasmUiAccountEncoding> for UiAccountEncoding {
    fn from(encoding: WasmUiAccountEncoding) -> Self {
        match encoding {
            WasmUiAccountEncoding::Binary => UiAccountEncoding::Binary,
            WasmUiAccountEncoding::Base58 => UiAccountEncoding::Base58,
            WasmUiAccountEncoding::Base64 => UiAccountEncoding::Base64,
            WasmUiAccountEncoding::JsonParsed => UiAccountEncoding::JsonParsed,
            WasmUiAccountEncoding::Base64Zstd => UiAccountEncoding::Base64Zstd,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmAccountInput {
    pubkey: String,
    owner: String,
    #[serde(deserialize_with = "deserialize_u64")]
    lamports: u64,
    executable: bool,
    #[serde(deserialize_with = "deserialize_u64")]
    rent_epoch: u64,
    data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmAccountContext {
    spl_token_mint: Option<WasmMintContext>,
    unix_timestamp: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmMintContext {
    pubkey: String,
    data: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmErrorPayload {
    code: &'static str,
    message: String,
    pubkey: Option<String>,
    owner: Option<String>,
    encoding: Option<String>,
}

#[derive(Debug, thiserror::Error)]
enum AccountEncodingError {
    #[error("invalid account input JSON: {0}")]
    InvalidAccountInputJson(serde_json::Error),

    #[error("invalid account context JSON: {0}")]
    InvalidAccountContextJson(serde_json::Error),

    #[error("invalid account pubkey '{value}': {reason}")]
    InvalidPubkey { value: String, reason: String },

    #[error("invalid account owner '{value}': {reason}")]
    InvalidOwner { value: String, reason: String },

    #[error("invalid account data: expected base64 bytes ({0})")]
    InvalidAccountData(String),

    #[error("invalid encoded account data: expected {encoding} ({reason})")]
    InvalidEncodedData {
        encoding: &'static str,
        reason: String,
    },

    #[error("cannot convert from jsonParsed account data")]
    CannotConvertJsonParsed,

    #[error("account encoding failed: {0}")]
    Parser(String),
}

impl AccountEncodingError {
    fn to_js_error(
        &self,
        pubkey: Option<String>,
        owner: Option<String>,
        encoding: Option<WasmUiAccountEncoding>,
    ) -> JsError {
        let code = match self {
            AccountEncodingError::InvalidAccountInputJson(_)
            | AccountEncodingError::InvalidAccountContextJson(_)
            | AccountEncodingError::InvalidPubkey { .. }
            | AccountEncodingError::InvalidOwner { .. }
            | AccountEncodingError::InvalidAccountData(_)
            | AccountEncodingError::InvalidEncodedData { .. }
            | AccountEncodingError::CannotConvertJsonParsed => "INVALID_ACCOUNT_DATA",
            AccountEncodingError::Parser(_) => "WASM_PARSER_ERROR",
        };

        let payload = WasmErrorPayload {
            code,
            message: self.to_string(),
            pubkey,
            owner,
            encoding: encoding.map(|encoding| encoding_name(encoding).to_string()),
        };
        JsError::new(
            &serde_json::to_string(&payload)
                .unwrap_or_else(|_| format!(r#"{{"code":"{code}","message":"{self}"}}"#)),
        )
    }
}

#[wasm_bindgen]
pub fn encode_account(
    account_json: &str,
    encoding: WasmUiAccountEncoding,
    context_json: Option<String>,
    data_slice_json: Option<String>,
) -> Result<String, JsError> {
    let input = parse_account_input(account_json)
        .map_err(|error| error.to_js_error(None, None, Some(encoding)))?;
    let result = encode_account_inner(&input, encoding, context_json, data_slice_json);
    result.map_err(|error| {
        error.to_js_error(
            Some(input.pubkey.clone()),
            Some(input.owner.clone()),
            Some(encoding),
        )
    })
}

#[wasm_bindgen]
pub fn get_account_mint(owner: &str, data: &str) -> Result<Option<String>, JsError> {
    let owner = parse_owner(owner).map_err(|error| error.to_js_error(None, None, None))?;
    if !is_known_spl_token_id(&owner) {
        return Ok(None);
    }
    let data = decode_base64_data(data)
        .map_err(|error| error.to_js_error(None, Some(owner.to_string()), None))?;
    Ok(get_token_account_mint(&data).map(|mint| mint.to_string()))
}

#[wasm_bindgen]
pub fn convert_account_data(
    input: &str,
    from: WasmUiAccountEncoding,
    to: WasmUiAccountEncoding,
) -> Result<String, JsError> {
    convert_account_data_inner(input, from, to)
        .map_err(|error| error.to_js_error(None, None, Some(to)))
}

fn encode_account_inner(
    input: &WasmAccountInput,
    encoding: WasmUiAccountEncoding,
    context_json: Option<String>,
    data_slice_json: Option<String>,
) -> Result<String, AccountEncodingError> {
    let pubkey = parse_pubkey(&input.pubkey)?;
    let owner = parse_owner(&input.owner)?;
    let data = decode_base64_data(&input.data)?;
    let account = Account {
        lamports: input.lamports,
        data,
        owner,
        executable: input.executable,
        rent_epoch: input.rent_epoch,
    };
    let context = match encoding {
        WasmUiAccountEncoding::JsonParsed => parse_account_context(context_json)?,
        _ => None,
    };
    let parsed_token = matches!(encoding, WasmUiAccountEncoding::JsonParsed)
        && is_known_spl_token_id(&owner);
    let additional_data = if parsed_token {
        build_additional_data(&account.data, context.as_ref())?
    } else {
        None
    };
    let data_slice = if parsed_token {
        None
    } else {
        parse_data_slice(data_slice_json)?
    };
    let encoded = encode_ui_account(&pubkey, &account, encoding.into(), additional_data, data_slice);

    serde_json::to_string(&encoded).map_err(|error| AccountEncodingError::Parser(error.to_string()))
}

fn convert_account_data_inner(
    input: &str,
    from: WasmUiAccountEncoding,
    to: WasmUiAccountEncoding,
) -> Result<String, AccountEncodingError> {
    let data = decode_account_data(input, from)?;
    encode_account_data(&data, to)
}

fn parse_account_input(input: &str) -> Result<WasmAccountInput, AccountEncodingError> {
    serde_json::from_str(input).map_err(AccountEncodingError::InvalidAccountInputJson)
}

fn deserialize_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum U64StringOrNumber {
        Number(u64),
        String(String),
    }

    match U64StringOrNumber::deserialize(deserializer)? {
        U64StringOrNumber::Number(value) => Ok(value),
        U64StringOrNumber::String(value) => value.parse::<u64>().map_err(D::Error::custom),
    }
}

fn parse_account_context(
    context_json: Option<String>,
) -> Result<Option<WasmAccountContext>, AccountEncodingError> {
    match context_json {
        Some(context_json) if !context_json.trim().is_empty() => {
            serde_json::from_str(&context_json)
                .map(Some)
                .map_err(AccountEncodingError::InvalidAccountContextJson)
        }
        _ => Ok(None),
    }
}

fn parse_data_slice(
    data_slice_json: Option<String>,
) -> Result<Option<UiDataSliceConfig>, AccountEncodingError> {
    match data_slice_json {
        Some(data_slice_json) if !data_slice_json.trim().is_empty() => {
            serde_json::from_str(&data_slice_json)
                .map(Some)
                .map_err(AccountEncodingError::InvalidAccountContextJson)
        }
        _ => Ok(None),
    }
}

fn parse_pubkey(value: &str) -> Result<Pubkey, AccountEncodingError> {
    Pubkey::from_str(value).map_err(|error| AccountEncodingError::InvalidPubkey {
        value: value.to_string(),
        reason: error.to_string(),
    })
}

fn parse_owner(value: &str) -> Result<Pubkey, AccountEncodingError> {
    Pubkey::from_str(value).map_err(|error| AccountEncodingError::InvalidOwner {
        value: value.to_string(),
        reason: error.to_string(),
    })
}

fn decode_base64_data(data: &str) -> Result<Vec<u8>, AccountEncodingError> {
    BASE64_STANDARD
        .decode(data)
        .map_err(|error| AccountEncodingError::InvalidAccountData(error.to_string()))
}

fn decode_account_data(
    input: &str,
    encoding: WasmUiAccountEncoding,
) -> Result<Vec<u8>, AccountEncodingError> {
    match encoding {
        WasmUiAccountEncoding::Binary | WasmUiAccountEncoding::Base58 => bs58::decode(input)
            .into_vec()
            .map_err(|error| AccountEncodingError::InvalidEncodedData {
                encoding: encoding_name(encoding),
                reason: error.to_string(),
            }),
        WasmUiAccountEncoding::Base64 => BASE64_STANDARD.decode(input).map_err(|error| {
            AccountEncodingError::InvalidEncodedData {
                encoding: encoding_name(encoding),
                reason: error.to_string(),
            }
        }),
        WasmUiAccountEncoding::Base64Zstd => {
            let encoded = UiAccountData::Binary(
                input.to_string(),
                UiAccountEncoding::Base64Zstd,
            );
            encoded
                .decode()
                .ok_or_else(|| AccountEncodingError::InvalidEncodedData {
                    encoding: encoding_name(encoding),
                    reason: "failed to decompress base64+zstd account data".to_string(),
                })
        }
        WasmUiAccountEncoding::JsonParsed => Err(AccountEncodingError::CannotConvertJsonParsed),
    }
}

fn encode_account_data(
    data: &[u8],
    encoding: WasmUiAccountEncoding,
) -> Result<String, AccountEncodingError> {
    match encoding {
        WasmUiAccountEncoding::Binary | WasmUiAccountEncoding::Base58 => {
            Ok(bs58::encode(data).into_string())
        }
        WasmUiAccountEncoding::Base64 => Ok(BASE64_STANDARD.encode(data)),
        WasmUiAccountEncoding::Base64Zstd => {
            let account = Account {
                data: data.to_vec(),
                ..Account::default()
            };
            let encoded = encode_ui_account(
                &Pubkey::default(),
                &account,
                UiAccountEncoding::Base64Zstd,
                None,
                None,
            );
            match encoded.data {
                UiAccountData::Binary(value, UiAccountEncoding::Base64Zstd) => Ok(value),
                _ => Err(AccountEncodingError::Parser(
                    "base64+zstd compression failed".to_string(),
                )),
            }
        }
        WasmUiAccountEncoding::JsonParsed => Err(AccountEncodingError::CannotConvertJsonParsed),
    }
}

fn build_additional_data(
    data: &[u8],
    context: Option<&WasmAccountContext>,
) -> Result<Option<AccountAdditionalDataV3>, AccountEncodingError> {
    let Some(mint_pubkey) = get_token_account_mint(data) else {
        return Ok(None);
    };

    let Some(mint_context) = context.and_then(|value| value.spl_token_mint.as_ref()) else {
        return Ok(None);
    };

    if mint_context.pubkey != mint_pubkey.to_string() {
        return Ok(None);
    }

    let mint_data = decode_base64_data(&mint_context.data)?;
    Ok(extract_spl_token_additional_data(
        &mint_data,
        context.and_then(|value| value.unix_timestamp),
    )
    .map(|data| AccountAdditionalDataV3 {
        spl_token_additional_data: Some(data),
    }))
}

fn extract_spl_token_additional_data(
    mint_data: &[u8],
    unix_timestamp: Option<i64>,
) -> Option<SplTokenAdditionalDataV2> {
    let mint = StateWithExtensions::<Mint>::unpack(mint_data).ok()?;
    let interest_bearing_config = match mint.get_extension::<InterestBearingConfig>() {
        Ok(config) => Some((*config, unix_timestamp?)),
        Err(_) => None,
    };
    let scaled_ui_amount_config = match mint.get_extension::<ScaledUiAmountConfig>() {
        Ok(config) => Some((*config, unix_timestamp?)),
        Err(_) => None,
    };

    Some(SplTokenAdditionalDataV2 {
        decimals: mint.base.decimals,
        interest_bearing_config,
        scaled_ui_amount_config,
    })
}

fn encoding_name(encoding: WasmUiAccountEncoding) -> &'static str {
    match encoding {
        WasmUiAccountEncoding::Binary => "binary",
        WasmUiAccountEncoding::Base58 => "base58",
        WasmUiAccountEncoding::Base64 => "base64",
        WasmUiAccountEncoding::JsonParsed => "jsonParsed",
        WasmUiAccountEncoding::Base64Zstd => "base64+zstd",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account_json(data: &[u8]) -> String {
        serde_json::json!({
            "pubkey": Pubkey::default().to_string(),
            "owner": Pubkey::default().to_string(),
            "lamports": 10,
            "executable": false,
            "rentEpoch": 0,
            "data": BASE64_STANDARD.encode(data),
        })
        .to_string()
    }

    #[test]
    fn test_encode_account_base64_shape() {
        let encoded = encode_account(
            &account_json(&[1, 2, 3]),
            WasmUiAccountEncoding::Base64,
            None,
            None,
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_str(&encoded).unwrap();

        assert_eq!(value["lamports"], 10);
        assert_eq!(value["data"][0], "AQID");
        assert_eq!(value["data"][1], "base64");
        assert_eq!(value["space"], 3);
    }

    #[test]
    fn test_json_parsing_rejects_unsupported_and_malformed_accounts() {
        for owner in [
            Pubkey::new_from_array([99; 32]).to_string(),
            "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA".to_string(),
        ] {
            let mut input = parse_account_input(&account_json(&[1])).unwrap();
            input.owner = owner;
            for result in [
                encode_account_inner(&input, WasmUiAccountEncoding::JsonParsed, None, None),
                parse_account_json_inner(&input, None),
            ] {
                assert!(matches!(result, Err(AccountEncodingError::Parser(_))));
            }
        }
    }

    #[test]
    fn test_json_parsing_requires_mint_context() {
        let input = token_account_input();
        for result in [
            encode_account_inner(&input, WasmUiAccountEncoding::JsonParsed, None, None),
            parse_account_json_inner(&input, None),
        ] {
            assert!(matches!(
                result,
                Err(AccountEncodingError::MissingParseContext { .. })
            ));
        }
    }

    #[test]
    fn test_json_encoding_matches_parser_and_ignores_slice() {
        let input = token_account_input();
        let mut mint = [0_u8; 82];
        mint[44] = 6;
        mint[45] = 1;
        let context = serde_json::json!({
            "splTokenMint": {
                "pubkey": Pubkey::new_from_array([9; 32]).to_string(),
                "data": BASE64_STANDARD.encode(mint),
            },
        })
        .to_string();
        let encoded = encode_account_inner(
            &input,
            WasmUiAccountEncoding::JsonParsed,
            Some(context.clone()),
            Some(r#"{"offset":0,"length":0}"#.to_string()),
        )
        .unwrap();
        let parsed = parse_account_json_inner(&input, Some(context)).unwrap();
        let encoded: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&parsed).unwrap();
        assert_eq!(encoded["data"], parsed);
        assert_eq!(encoded["space"], 165);
        assert_eq!(parsed["program"], "spl-token");
        assert_eq!(parsed["parsed"]["info"]["tokenAmount"]["decimals"], 6);
    }

    fn token_account_input() -> WasmAccountInput {
        let mut data = [0_u8; 165];
        data[..32].fill(9);
        data[32..64].fill(10);
        data[108] = 1;
        let mut input = parse_account_input(&account_json(&data)).unwrap();
        input.owner = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA".to_string();
        input
    }

    #[test]
    fn test_convert_account_data_base64_to_base58() {
        let encoded = convert_account_data(
            "AQID",
            WasmUiAccountEncoding::Base64,
            WasmUiAccountEncoding::Base58,
        )
        .unwrap();

        assert_eq!(encoded, bs58::encode([1_u8, 2, 3]).into_string());
    }
}
