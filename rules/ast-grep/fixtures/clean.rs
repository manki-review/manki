const MAX_ITEMS: usize = 1000;

#[derive(Clone, Copy)]
enum Kind {
    Ping = 1,
}

fn encode(x: u64, kind: Kind, nbits: u64, items: &[Item], len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(items.len() * 2);
    let mut extra = Vec::with_capacity(MAX_ITEMS);
    let mut bounded = Vec::with_capacity(len);
    out.push((x >> 8) as u8);
    out.push((x & 0xff) as u8);
    out.push(Kind::Ping as u8);
    out.push(kind as u8);
    out.push(nbits as u8);
    out.push(HASH_LENGTH as u32);
    out.push(items.len() as u32);
    out.push(b'a' as u8);
    out.push(255 as u8);
    let wide = x as u64;
    let host: IpAddr = "127.0.0.1".parse().unwrap();
    let genesis = BlockHash::from_str("00000ffd590b1485b3caadc19b22e6379c733355108f107a430458cdf3407ab6").unwrap();
    let raw = hex::decode("deadbeef").expect("valid hex");
    let guard = lock.read().unwrap();
    let size = items.iter().map(|i| i.size()).sum::<usize>();
    extra.extend(raw);
    bounded.push(size);
    out
}

fn decode_bounded(r: &mut impl Read) -> Result<Vec<Item>, Error> {
    let len = VarInt::consensus_decode(r)?.0 as usize;
    let mut items = Vec::with_capacity(len.min(MAX_ITEMS));
    let mut more = Vec::with_capacity(std::cmp::min(len, MAX_ITEMS));
    let block_hash = BlockHash::consensus_decode(r)?;
    if block_hash == other_hash || public_key == expected_key || secret.len() == 32 || uses_password != 0 {
        items.append(&mut more);
    }
    assert_eq!(secret_key.secret_bytes(), expected_bytes);
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes() {
        let msg = Message::consensus_decode(&mut &BYTES[..]).unwrap();
        let n = msg.len() as u32;
        let data = Vec::<u8>::from_hex(HEX).unwrap();
        assert!(n > 0 && !data.is_empty());
    }
}

#[test]
#[should_panic]
fn rejects_short_input() {
    let _ = deserialize::<Header>(&[0u8; 2]).unwrap();
}

/// Reads a message from a live peer.
#[tokio::test]
// Needs a running node.
#[ignore]
async fn reads_from_peer() {
    let len = read_len(&mut stream).await;
    let buf: Vec<u8> = Vec::with_capacity(len);
    let msg = Message::consensus_decode(&mut &buf[..]).unwrap();
    assert!(msg.len() as u8 > 0);
}

#[cfg(bench)]
mod benches {
    #[bench]
    fn bench_decode(bh: &mut Bencher) {
        bh.iter(|| Block::consensus_decode(&mut &BLOCK[..]).unwrap());
    }
}
