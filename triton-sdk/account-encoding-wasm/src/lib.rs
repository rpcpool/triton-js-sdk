use {
    base64::{prelude::BASE64_STANDARD, Engine},
    serde::{de::Error as DeError, Deserialize, Deserializer, Serialize},
    solana_account::Account,
    solana_account_decoder::{
        encode_ui_account,
        parse_account_data::{
            parse_account_data_v3, AccountAdditionalDataV3, ParseAccountError,
            SplTokenAdditionalDataV2,
        },
    },
    solana_account_decoder_client_types::{
        ParsedAccount, UiAccount, UiAccountData, UiAccountEncoding, UiDataSliceConfig,
    },
    solana_pubkey::Pubkey,
    spl_token_2022_interface::{
        extension::{
            interest_bearing_mint::InterestBearingConfig, scaled_ui_amount::ScaledUiAmountConfig,
            BaseStateWithExtensions, StateWithExtensions,
        },
        state::{Account as TokenAccount, Mint},
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
struct MissingContextDetails {
    missing_accounts: Vec<String>,
    context_kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmErrorPayload {
    code: &'static str,
    message: String,
    pubkey: Option<String>,
    owner: Option<String>,
    encoding: Option<String>,
    missing_context: Option<MissingContextDetails>,
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

    #[error("missing parse context for {context_kind}: {missing_account}")]
    MissingParseContext {
        missing_account: String,
        context_kind: &'static str,
    },

    #[error("account parser failed: {0}")]
    Parser(String),
}

impl AccountEncodingError {
    fn to_js_error(
        &self,
        pubkey: Option<String>,
        owner: Option<String>,
        encoding: Option<WasmUiAccountEncoding>,
    ) -> JsError {
        let (code, missing_context) = match self {
            AccountEncodingError::InvalidAccountInputJson(_)
            | AccountEncodingError::InvalidAccountContextJson(_)
            | AccountEncodingError::InvalidPubkey { .. }
            | AccountEncodingError::InvalidOwner { .. }
            | AccountEncodingError::InvalidAccountData(_)
            | AccountEncodingError::InvalidEncodedData { .. }
            | AccountEncodingError::CannotConvertJsonParsed => ("INVALID_ACCOUNT_DATA", None),
            AccountEncodingError::MissingParseContext {
                missing_account,
                context_kind,
            } => (
                "MISSING_PARSE_CONTEXT",
                Some(MissingContextDetails {
                    missing_accounts: vec![missing_account.clone()],
                    context_kind: (*context_kind).to_string(),
                }),
            ),
            AccountEncodingError::Parser(_) => ("WASM_PARSER_ERROR", None),
        };

        let payload = WasmErrorPayload {
            code,
            message: self.to_string(),
            pubkey,
            owner,
            encoding: encoding.map(|encoding| encoding_name(encoding).to_string()),
            missing_context,
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
pub fn parse_account_json(
    account_json: &str,
    context_json: Option<String>,
) -> Result<String, JsError> {
    let input = parse_account_input(account_json)
        .map_err(|error| error.to_js_error(None, None, Some(WasmUiAccountEncoding::JsonParsed)))?;
    parse_account_json_inner(&input, context_json).map_err(|error| {
        error.to_js_error(
            Some(input.pubkey.clone()),
            Some(input.owner.clone()),
            Some(WasmUiAccountEncoding::JsonParsed),
        )
    })
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
    let encoded = if matches!(encoding, WasmUiAccountEncoding::JsonParsed) {
        let parsed = parse_account(&pubkey, &owner, &account.data, context_json)?;
        UiAccount {
            lamports: account.lamports,
            data: UiAccountData::Json(parsed),
            owner: owner.to_string(),
            executable: account.executable,
            rent_epoch: account.rent_epoch,
            space: Some(account.data.len() as u64),
        }
    } else {
        let data_slice = parse_data_slice(data_slice_json)?;
        encode_ui_account(&pubkey, &account, encoding.into(), None, data_slice)
    };

    serde_json::to_string(&encoded).map_err(|error| AccountEncodingError::Parser(error.to_string()))
}

fn parse_account_json_inner(
    input: &WasmAccountInput,
    context_json: Option<String>,
) -> Result<String, AccountEncodingError> {
    let pubkey = parse_pubkey(&input.pubkey)?;
    let owner = parse_owner(&input.owner)?;
    let data = decode_base64_data(&input.data)?;
    let parsed = parse_account(&pubkey, &owner, &data, context_json)?;

    serde_json::to_string(&parsed).map_err(|error| AccountEncodingError::Parser(error.to_string()))
}

fn parse_account(
    pubkey: &Pubkey,
    owner: &Pubkey,
    data: &[u8],
    context_json: Option<String>,
) -> Result<ParsedAccount, AccountEncodingError> {
    let context = parse_account_context(context_json)?;
    let additional_data = build_additional_data(data, context.as_ref())?;
    parse_account_data_v3(pubkey, owner, data, additional_data)
        .map_err(|error| map_parse_error(error, data))
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
            let encoded = solana_account_decoder_client_types::UiAccountData::Binary(
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
                solana_account_decoder_client_types::UiAccountData::Binary(
                    value,
                    UiAccountEncoding::Base64Zstd,
                ) => Ok(value),
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
    let Some(mint_pubkey) = spl_token_account_mint(data) else {
        return Ok(None);
    };

    let Some(context) = context else {
        return Err(AccountEncodingError::MissingParseContext {
            missing_account: mint_pubkey.to_string(),
            context_kind: "splTokenMint",
        });
    };
    let Some(mint_context) = &context.spl_token_mint else {
        return Err(AccountEncodingError::MissingParseContext {
            missing_account: mint_pubkey.to_string(),
            context_kind: "splTokenMint",
        });
    };

    if mint_context.pubkey != mint_pubkey.to_string() {
        return Err(AccountEncodingError::MissingParseContext {
            missing_account: mint_pubkey.to_string(),
            context_kind: "splTokenMint",
        });
    }

    let mint_data = decode_base64_data(&mint_context.data)?;
    let spl_token_additional_data =
        extract_spl_token_additional_data(&mint_data, context.unix_timestamp)?;

    Ok(Some(AccountAdditionalDataV3 {
        spl_token_additional_data: Some(spl_token_additional_data),
    }))
}

fn extract_spl_token_additional_data(
    mint_data: &[u8],
    unix_timestamp: Option<i64>,
) -> Result<SplTokenAdditionalDataV2, AccountEncodingError> {
    let mint = StateWithExtensions::<Mint>::unpack(mint_data).map_err(|error| {
        AccountEncodingError::Parser(format!("failed to parse SPL token mint context: {error}"))
    })?;
    let interest_bearing_config = mint
        .get_extension::<InterestBearingConfig>()
        .ok()
        .map(|config| (*config, unix_timestamp.unwrap_or_default()));
    let scaled_ui_amount_config = mint
        .get_extension::<ScaledUiAmountConfig>()
        .ok()
        .map(|config| (*config, unix_timestamp.unwrap_or_default()));

    Ok(SplTokenAdditionalDataV2 {
        decimals: mint.base.decimals,
        interest_bearing_config,
        scaled_ui_amount_config,
    })
}

fn spl_token_account_mint(data: &[u8]) -> Option<Pubkey> {
    StateWithExtensions::<TokenAccount>::unpack(data)
        .ok()
        .map(|account| account.base.mint)
}

fn map_parse_error(error: ParseAccountError, data: &[u8]) -> AccountEncodingError {
    match error {
        ParseAccountError::AdditionalDataMissing(_) => {
            if let Some(mint_pubkey) = spl_token_account_mint(data) {
                AccountEncodingError::MissingParseContext {
                    missing_account: mint_pubkey.to_string(),
                    context_kind: "splTokenMint",
                }
            } else {
                AccountEncodingError::Parser(error.to_string())
            }
        }
        other => AccountEncodingError::Parser(other.to_string()),
    }
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
