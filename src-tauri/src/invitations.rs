//! Human-readable invitations encode the existing secret, never a weaker PIN.
use bip39::{Language, Mnemonic};
use sha2::{Digest, Sha256};
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;

pub(crate) fn network_id(secret: &[u8; 32]) -> String {
    let mut hash = Sha256::new();
    hash.update(b"murmur-network-id-v2\0");
    hash.update(secret);
    let digest = hash.finalize();
    let mut id = [0u8; 16];
    id.copy_from_slice(&digest[..16]);
    Uuid::from_bytes(id).to_string()
}

pub(crate) fn phrase(id: &str, secret: &[u8; 32]) -> Result<String> {
    let words = Mnemonic::from_entropy(secret).map_err(message)?.to_string();
    if network_id(secret) == id {
        return Ok(words);
    }
    // Older networks used independent random IDs. Encode that ID too instead
    // of rotating their secrets, splitting the network, or losing saved notes.
    let id = Uuid::parse_str(id).map_err(message)?;
    let id_words = Mnemonic::from_entropy(id.as_bytes()).map_err(message)?;
    Ok(format!("{id_words} {words}"))
}

pub(crate) fn parse(input: &str) -> Result<(String, [u8; 32])> {
    if input.len() > 4096 {
        return Err("This invitation is too large.".into());
    }
    let words: Vec<_> = input
        .split(|c: char| c.is_whitespace() || c == '-')
        .filter(|word| !word.is_empty())
        .collect();
    if !matches!(words.len(), 24 | 36) {
        return Err(
            "Enter all 24 invitation words (36 for an older network), or paste an invitation link."
                .into(),
        );
    }
    let dictionary = Language::English.word_list();
    let normalized = words
        .iter()
        .enumerate()
        .map(|(index, word)| {
            let word = word.to_ascii_lowercase();
            if dictionary.contains(&word.as_str()) {
                return Ok(word);
            }
            // English BIP-39 words are unique in their first four letters.
            if word.len() == 4 && word.bytes().all(|byte| byte.is_ascii_lowercase()) {
                let mut matches = dictionary.iter().filter(|entry| entry.starts_with(&word));
                if let (Some(found), None) = (matches.next(), matches.next()) {
                    return Ok((*found).to_string());
                }
            }
            Err(format!("Invitation word {} is not recognized.", index + 1))
        })
        .collect::<Result<Vec<_>>>()?;
    let offset = if normalized.len() == 36 { 12 } else { 0 };
    let secret: [u8; 32] = entropy(&normalized[offset..])?
        .try_into()
        .map_err(|_| "Invalid invitation secret.".to_string())?;
    let id = if offset == 12 {
        Uuid::from_slice(&entropy(&normalized[..12])?)
            .map_err(message)?
            .to_string()
    } else {
        network_id(&secret)
    };
    Ok((id, secret))
}

fn entropy(words: &[String]) -> Result<Vec<u8>> {
    Mnemonic::parse_in_normalized(Language::English, &words.join(" "))
        .map(|mnemonic| mnemonic.to_entropy())
        .map_err(|_| {
            "The invitation words do not match their checksum. Check their spelling and order."
                .into()
        })
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_network_roundtrips_all_secret_bytes_in_24_words() {
        assert_eq!(network_id(&[0; 32]), "4beeff20-5826-96b4-832c-9c895083db49");
        let secret = [42u8; 32];
        let id = network_id(&secret);
        let words = phrase(&id, &secret).unwrap();
        assert_eq!(words.split_whitespace().count(), 24);
        assert_eq!(parse(&words).unwrap(), (id, secret));
        assert_ne!(network_id(&secret), network_id(&[43; 32]));
    }

    #[test]
    fn old_network_roundtrips_without_rotating_identity_or_secret() {
        let id = "00112233-4455-6677-8899-aabbccddeeff";
        let secret = [17u8; 32];
        let words = phrase(id, &secret).unwrap();
        assert_eq!(words.split_whitespace().count(), 36);
        assert_eq!(parse(&words).unwrap(), (id.into(), secret));
    }

    #[test]
    fn accepts_case_whitespace_and_unique_four_letter_abbreviations() {
        let secret = [123u8; 32];
        let id = network_id(&secret);
        let words = phrase(&id, &secret).unwrap();
        let shortened = words
            .split_whitespace()
            .map(|word| word.chars().take(4).collect::<String>().to_uppercase())
            .collect::<Vec<_>>()
            .join(" -\n ");
        assert_eq!(parse(&shortened).unwrap(), (id, secret));
    }

    #[test]
    fn rejects_missing_unknown_and_checksum_invalid_words() {
        assert!(parse("alpha beta gamma delta").is_err());
        assert!(parse(&vec!["abandon"; 24].join(" ")).is_err());
        assert!(parse(&vec!["invalidword"; 24].join(" ")).is_err());
        assert!(parse(&"a".repeat(4097)).is_err());
    }
}
