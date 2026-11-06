use std::io::Read;

fn decode_message(r: &mut impl Read, bytes: &[u8], text: &str) -> Message {
    let len = VarInt::consensus_decode(r).unwrap().0; // expect: rust-unwrap-decoded-input
    let mut items = Vec::with_capacity(len as usize); // expect: rust-capacity-from-decoded-length
    let count = r.read_u32::<LittleEndian>().expect("count"); // expect: rust-unwrap-decoded-input
    let names: Vec<String> = Vec::with_capacity(count as usize); // expect: rust-capacity-from-decoded-length
    let header: Header = deserialize(bytes).unwrap(); // expect: rust-unwrap-decoded-input
    let port = text.parse::<u16>().unwrap(); // expect: rust-unwrap-decoded-input
    let body = std::str::from_utf8(&bytes[4..]).expect("utf-8"); // expect: rust-unwrap-decoded-input
    let short = len as u32; // expect: rust-truncating-cast
    let flags = items.len() as u8; // expect: rust-truncating-cast
    let offset = r.offset as u32; // expect: rust-truncating-cast
    let ptr = unsafe { bytes.as_ptr().add(4) }; // expect: rust-unsafe-block
    Message { items, names, header, port, body, short, flags, offset, ptr }
}

fn verify(key: &SecretKey, tag: &[u8], expected_mac: [u8; 32], password: &str, input: &str) -> bool {
    if &key.secret_bytes()[..] == tag { // expect: rust-secret-equality
        return true;
    }
    if compute_hmac(tag) != expected_mac { // expect: rust-secret-equality
        return false;
    }
    password == input // expect: rust-secret-equality
}
