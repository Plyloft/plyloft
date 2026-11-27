//! Key chords (`ctrl+shift+q`, `cmd+k`, `escape`) as Windows virtual keys.
//! `cmd` means Ctrl on Windows, so a walk written for the Mac presses the
//! Windows shortcut. The Windows key is refused: it reaches the shell.

pub const VK_SHIFT: u16 = 0x10;
pub const VK_CONTROL: u16 = 0x11;
pub const VK_MENU: u16 = 0x12;
pub const VK_RETURN: u16 = 0x0D;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Key {
    /// A virtual key; `true` when it needs KEYEVENTF_EXTENDEDKEY.
    Vk(u16, bool),
    /// A character resolved with VkKeyScanW on the VM's own layout.
    Char(char),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chord {
    pub modifiers: Vec<u16>,
    pub key: Key,
}

fn named(name: &str) -> Option<Key> {
    let vk = |v: u16| Some(Key::Vk(v, false));
    let ext = |v: u16| Some(Key::Vk(v, true));
    match name {
        "enter" | "return" => vk(VK_RETURN),
        "escape" | "esc" => vk(0x1B),
        "tab" => vk(0x09),
        "space" => vk(0x20),
        "backspace" => vk(0x08),
        "delete" | "del" => ext(0x2E),
        "insert" => ext(0x2D),
        "up" => ext(0x26),
        "down" => ext(0x28),
        "left" => ext(0x25),
        "right" => ext(0x27),
        "home" => ext(0x24),
        "end" => ext(0x23),
        "pageup" => ext(0x21),
        "pagedown" => ext(0x22),
        _ => {
            let n: u16 = name.strip_prefix('f')?.parse().ok()?;
            (1..=12).contains(&n).then_some(Key::Vk(0x6F + n, false))
        }
    }
}

pub fn parse(text: &str) -> Result<Chord, String> {
    let parts: Vec<&str> = text.split('+').map(str::trim).collect();
    // `ctrl++` is a plus key: rejoin a trailing empty part.
    let (mods, last) = match parts.as_slice() {
        [] => return Err("empty key chord".into()),
        [.., a, b] if a.is_empty() && b.is_empty() => (&parts[..parts.len() - 2], "+"),
        [rest @ .., last] => (rest, *last),
    };
    if last.is_empty() {
        return Err(format!("no key in chord {text:?}"));
    }
    let mut modifiers = Vec::new();
    for part in mods {
        let vk = match part.to_ascii_lowercase().as_str() {
            "cmd" | "command" | "meta" | "ctrl" | "control" => VK_CONTROL,
            "alt" | "option" | "opt" => VK_MENU,
            "shift" => VK_SHIFT,
            "win" | "super" => return Err("the Windows key is not allowed (it reaches the shell, not Plyloft Test)".into()),
            other => return Err(format!("unknown modifier {other:?}")),
        };
        if !modifiers.contains(&vk) {
            modifiers.push(vk);
        }
    }
    let lower = last.to_ascii_lowercase();
    let key = if let Some(key) = named(&lower) {
        key
    } else {
        let mut chars = last.chars();
        match (chars.next(), chars.next()) {
            (Some(c), None) if c.is_ascii_alphabetic() => Key::Vk(c.to_ascii_uppercase() as u16, false),
            (Some(c), None) if c.is_ascii_digit() => Key::Vk(c as u16, false),
            (Some(c), None) => Key::Char(c),
            _ => return Err(format!("unknown key {last:?}")),
        }
    };
    Ok(Chord { modifiers, key })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cmd_is_ctrl_on_windows() {
        assert_eq!(parse("cmd+q").unwrap(), Chord { modifiers: vec![VK_CONTROL], key: Key::Vk(b'Q' as u16, false) });
        assert_eq!(parse("ctrl+shift+q").unwrap().modifiers, vec![VK_CONTROL, VK_SHIFT]);
        assert_eq!(parse("cmd+ctrl+k").unwrap().modifiers, vec![VK_CONTROL], "no duplicate ctrl");
    }

    #[test]
    fn named_and_punctuation_keys() {
        assert_eq!(parse("escape").unwrap().key, Key::Vk(0x1B, false));
        assert_eq!(parse("Up").unwrap().key, Key::Vk(0x26, true));
        assert_eq!(parse("f5").unwrap().key, Key::Vk(0x74, false));
        assert_eq!(parse("cmd+,").unwrap().key, Key::Char(','));
        assert_eq!(parse("ctrl+alt+shift+.").unwrap().key, Key::Char('.'));
        assert_eq!(parse("ctrl++").unwrap().key, Key::Char('+'));
        assert_eq!(parse("7").unwrap().key, Key::Vk(b'7' as u16, false));
    }

    #[test]
    fn refusals() {
        assert!(parse("win+r").unwrap_err().contains("Windows key"));
        assert!(parse("hyper+x").is_err());
        assert!(parse("").is_err());
        assert!(parse("f13").is_err());
        assert!(parse("ctrl+").is_err());
    }
}
