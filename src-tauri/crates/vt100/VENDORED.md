# vt100, vendored by Plyloft

- **Upstream:** [vt100](https://crates.io/crates/vt100) **0.16.2** by Jesse Luehrs,
  <https://github.com/doy/vt100-rust>, commit `eb66ffaf7d771c13303ef73b29f6f2a56fdacecf`.
- **Licence:** MIT, kept as is in [LICENSE](LICENSE).
- **Used through** `[patch.crates-io] vt100 = { path = "crates/vt100" }` in
  `src-tauri/Cargo.toml`, on the Mac and on Windows alike. Plyloft's only user
  is `src-tauri/src/chat_screen.rs`, a card chat's emulated Claude screen: its
  matchers read the rows, and "Show terminal" first paints from
  `state_formatted()`.
- **Kept from upstream:** `src/` unchanged except as below, README, CHANGELOG.
  Dropped: upstream's dev-dependencies (its `tests/` directory is not
  vendored). Upstream's own suite (all 18 test files, quickcheck included)
  was run against the patched `src/` on 2026-10-23 and passes.
- **Lints:** upstream's `#![warn(clippy::cargo)]` is `allow` here: its checks
  read every manifest of the workspace (Plyloft's app included), not this
  crate's code. `cargo clippy -p vt100 --all-targets -- -D warnings` is clean.

## The change (1.169.0, card B4)

Upstream sizes each code point on its own (`unicode-width`), so an emoji made
wide by VS16 (⚠️ = U+26A0 U+FE0F) was one cell, a ZWJ sequence (👨‍👩‍👧) six,
a flag (🇮🇹) two narrow cells, a skin tone (👍🏽) four. Plyloft's terminals
(xterm.js 6 with the unicode-graphemes addon, "15-graphemes"), the console
host Plyloft ships on Windows (OpenConsole) and the TUIs drawing into them
(Claude Code, Codex) size each as one two-column character. A grid that
disagrees puts whatever the TUI places by absolute position one cell off, and
its replay draws rows one cell too wide.

The patch forms grapheme clusters as xterm.js does:

- **A join state** (`grapheme::JoinState`, xterm.js's `precedingJoinState`):
  the cluster the last printed character is in — its cell, its width, whether
  it is a lone regional indicator, whether it ends with a ZWJ. Set by every
  printed character; cleared by every other action of the parser (a control
  character — CR, LF, BS… —, a character handed to the callbacks (U+FFFD,
  C1), an escape, a CSI sequence — SGR and cursor moves
  included —, OSC, DCS) and by a resize; kept across `process()` calls.
  Joining is decided from it, not from the cell's text, so a cluster longer
  than a cell's 22 bytes (👨‍👩‍👧‍👦, 👩‍❤️‍💋‍👨, 🏴󠁧󠁢󠁥󠁮󠁧󠁿) stays one cluster; the cell keeps
  what fits.
- **What joins** (UAX #29): Extend and ZWJ always (GB9: combining marks, ZWJ,
  variation selectors, tags, skin tones) — a space is a cluster too; after a
  ZWJ, an `Extended_Pictographic` character (GB11), whatever came before the
  ZWJ; a regional indicator after a lone one (GB12/13).
- **Width** after a join: the larger of the cluster's and the character's own
  (two for VS16, a skin tone or a wide character; one otherwise), two for a
  flag — xterm.js's `max(oldWidth, width)`. So 👁‍🗨 stays one column and ❤‍🔥
  is two, as in xterm.js.
- **A VS16 with no cluster before it** (after an escape, CR, BS) is a
  two-column cell of its own, as xterm.js draws it.
- **Widening** a one-column cluster takes the column after it: that column
  becomes its continuation (a wide character starting there loses its other
  half, and, as upstream does when it writes over one, a row whose last column
  that was is no longer marked wrapped) and the cursor moves on one. In the
  row's last column, the cluster moves to the start of the next row (a wrap).

Files: `src/grapheme.rs` (new: the join state and rule; the tests, through
the parser, against the numbers xterm.js 6 draws for the same bytes),
`src/screen.rs` (the `grapheme` field; `text` joins first, starts the
cluster last, and gives a lone VS16 two columns; `grapheme_reset`,
`join_grapheme`), `src/perform.rs` (every non-print action resets; `hook` and
`unhook` added for DCS), `src/cell.rs` (`set_wide` is `pub(crate)`),
`src/lib.rs` (`mod grapheme`; `clippy::cargo` allowed).

## Known gaps (still upstream's, or not xterm.js's)

- A spacing mark (GB9a, e.g. Devanagari ा after क) is a cell of its own;
  xterm.js joins it into one (pinned: `known_gap_a_spacing_mark_is_its_own_cell`).
- A zero-width character other than VS16 with no cluster before it (after an
  escape) is appended to the cell before the cursor, upstream's rule; at
  column 0 after a CR it is dropped.
- No DECAWM (autowrap off) or IRM (insert mode): upstream has neither.
- `set_size` narrower than a wide character at the new last column leaves its
  half over the edge, as upstream does (a resize also ends the cluster).
- Which row is marked wrapped differs in convention (vt100 marks the row
  continued, xterm.js the continuation); the cells are the same.

To update upstream: copy the new release's `src/`, LICENSE, README and
CHANGELOG over this folder, re-apply the diff below, run upstream's tests
against it, `cargo test -p vt100` and `cargo test --lib chat_screen::`.

## The diff against upstream 0.16.2 (`src/grapheme.rs` is new, not shown)

```diff
--- upstream/src/lib.rs
+++ src/lib.rs
@@ -34,7 +34,10 @@
 //! ```
 
 #![warn(missing_docs)]
-#![warn(clippy::cargo)]
+// Plyloft (VENDORED.md): upstream warns on clippy::cargo, whose checks read
+// the whole workspace's manifests (Plyloft's own app included), not this
+// crate's code.
+#![allow(clippy::cargo)]
 #![warn(clippy::pedantic)]
 #![warn(clippy::nursery)]
 #![warn(clippy::as_conversions)]
@@ -50,6 +53,7 @@
 mod attrs;
 mod callbacks;
 mod cell;
+mod grapheme;
 mod grid;
 mod parser;
 mod perform;
--- upstream/src/cell.rs
+++ src/cell.rs
@@ -110,7 +110,7 @@
         self.len & IS_WIDE_CONTINUATION != 0
     }
 
-    fn set_wide(&mut self, wide: bool) {
+    pub(crate) fn set_wide(&mut self, wide: bool) {
         if wide {
             self.len |= IS_WIDE;
         } else {
--- upstream/src/perform.rs
+++ src/perform.rs
@@ -31,8 +31,20 @@
 }
 
 impl<CB: crate::callbacks::Callbacks> vte::Perform for WrappedScreen<CB> {
+    // Plyloft (VENDORED.md): a DCS string ends the grapheme cluster too
+    // (upstream ignores DCS).
+    fn hook(&mut self, _params: &vte::Params, _intermediates: &[u8], _ignore: bool, _action: char) {
+        self.screen.grapheme_reset();
+    }
+
+    fn unhook(&mut self) {
+        self.screen.grapheme_reset();
+    }
+
     fn print(&mut self, c: char) {
         if c == '\u{fffd}' || ('\u{80}'..'\u{a0}').contains(&c) {
+            // Plyloft (VENDORED.md): not printed here, so no cluster goes on.
+            self.screen.grapheme_reset();
             self.callbacks.unhandled_char(&mut self.screen, c);
         } else {
             self.screen.text(c);
@@ -40,6 +52,9 @@
     }
 
     fn execute(&mut self, b: u8) {
+        // Plyloft (VENDORED.md): every action but a printed character ends
+        // the grapheme cluster.
+        self.screen.grapheme_reset();
         match b {
             7 => self.callbacks.audible_bell(&mut self.screen),
             8 => self.screen.bs(),
@@ -56,6 +71,7 @@
     }
 
     fn esc_dispatch(&mut self, intermediates: &[u8], _ignore: bool, b: u8) {
+        self.screen.grapheme_reset();
         if let Some(i) = intermediates.first() {
             self.callbacks.unhandled_escape(
                 &mut self.screen,
@@ -91,6 +107,7 @@
         _ignore: bool,
         c: char,
     ) {
+        self.screen.grapheme_reset();
         let unhandled = |screen: &mut crate::screen::Screen| {
             self.callbacks.unhandled_csi(
                 screen,
@@ -196,6 +213,7 @@
     }
 
     fn osc_dispatch(&mut self, params: &[&[u8]], _bel_terminated: bool) {
+        self.screen.grapheme_reset();
         match params {
             [b"0", s] => {
                 self.callbacks.set_window_icon_name(&mut self.screen, s);
--- upstream/src/screen.rs
+++ src/screen.rs
@@ -62,6 +62,9 @@
     modes: u8,
     mouse_protocol_mode: MouseProtocolMode,
     mouse_protocol_encoding: MouseProtocolEncoding,
+
+    // Plyloft (VENDORED.md): the cluster the last printed character is in.
+    grapheme: Option<crate::grapheme::JoinState>,
 }
 
 impl Screen {
@@ -81,11 +84,14 @@
             modes: 0,
             mouse_protocol_mode: MouseProtocolMode::default(),
             mouse_protocol_encoding: MouseProtocolEncoding::default(),
+
+            grapheme: None,
         }
     }
 
     /// Resizes the terminal.
     pub fn set_size(&mut self, rows: u16, cols: u16) {
+        self.grapheme = None;
         self.grid.set_size(crate::grid::Size { rows, cols });
         self.alternate_grid
             .set_size(crate::grid::Size { rows, cols });
@@ -702,6 +708,74 @@
 }
 
 impl Screen {
+    /// Plyloft (VENDORED.md): anything but a printed character ends the
+    /// cluster (xterm.js resets its join state the same way).
+    pub(crate) fn grapheme_reset(&mut self) {
+        self.grapheme = None;
+    }
+
+    /// Plyloft (VENDORED.md): append `c` to the cluster just printed, which
+    /// is `width` wide after. Widening a one-column cluster takes the column
+    /// after it, as xterm.js does: that column becomes its continuation (a
+    /// wide character starting there loses its other half) and the cursor
+    /// moves on one; when the cluster is in the row's last column, it moves
+    /// to the start of the next row (a wrap).
+    fn join_grapheme(&mut self, c: char, width: u16) {
+        let Some(state) = self.grapheme else { return };
+        let at = state.at;
+        let pos = self.grid().pos();
+        let size = self.grid().size();
+        let widens = width > state.width;
+        if !widens || pos.row != at.row || pos.col != at.col + 1 || size.cols < 2 {
+            // Nothing to widen (or, defensively, the cursor is not right
+            // after the cluster): appended, its width kept.
+            if let Some(cell) = self.grid_mut().drawing_cell_mut(at) {
+                cell.append(c);
+            }
+            self.grapheme = Some(state.joined(c, state.width));
+            return;
+        }
+        let attrs = *self.grid().drawing_cell(at).unwrap().attrs();
+        let start = if at.col + 1 < size.cols {
+            at
+        } else {
+            // The row's last column: the cluster moves to the next row.
+            let contents = self.grid().drawing_cell(at).unwrap().contents().to_string();
+            self.grid_mut().drawing_cell_mut(at).unwrap().clear(attrs);
+            self.grid_mut().col_wrap(2, true);
+            let start = self.grid().pos();
+            let mut chars = contents.chars();
+            let cell = self.grid_mut().drawing_cell_mut(start).unwrap();
+            if let Some(first) = chars.next() {
+                cell.set(first, attrs);
+            }
+            for rest in chars {
+                cell.append(rest);
+            }
+            self.grid_mut().col_inc(1);
+            start
+        };
+        self.grid_mut().drawing_cell_mut(start).unwrap().append(c);
+        self.grid_mut().drawing_cell_mut(start).unwrap().set_wide(true);
+        let next = crate::grid::Pos { row: start.row, col: start.col + 1 };
+        if self.grid().drawing_cell(next).unwrap().is_wide() {
+            let other_half = crate::grid::Pos { row: next.row, col: next.col + 1 };
+            if let Some(cell) = self.grid_mut().drawing_cell_mut(other_half) {
+                cell.clear(attrs);
+                // As upstream does when it writes over a wide character whose
+                // other half is the row's last column.
+                if other_half.col == size.cols - 1 {
+                    self.grid_mut().drawing_row_mut(next.row).unwrap().wrap(false);
+                }
+            }
+        }
+        let next_cell = self.grid_mut().drawing_cell_mut(next).unwrap();
+        next_cell.clear(crate::attrs::Attrs::default());
+        next_cell.set_wide_continuation(true);
+        self.grid_mut().col_inc(1);
+        self.grapheme = Some(crate::grapheme::JoinState { at: start, ..state }.joined(c, width));
+    }
+
     pub(crate) fn text(&mut self, c: char) {
         let pos = self.grid().pos();
         let size = self.grid().size();
@@ -718,6 +792,17 @@
             // width() can only return 0, 1, or 2
             .unwrap();
 
+        // Plyloft (VENDORED.md): a character that extends the cluster just
+        // printed joins its cell; a VS16 with no cluster before it is a
+        // two-column cell of its own, as xterm.js draws it.
+        if let crate::grapheme::Join::Into { width } =
+            crate::grapheme::join(self.grapheme.as_ref(), c)
+        {
+            self.join_grapheme(c, width);
+            return;
+        }
+        let width = if c == crate::grapheme::VS16 && size.cols >= 2 { 2 } else { width };
+
         // it doesn't make any sense to wrap if the last column in a row
         // didn't already have contents. don't try to handle the case where a
         // character wraps because there was only one column left in the
@@ -880,6 +965,10 @@
                 // that self.grid().pos().col has a valid value.
                 .unwrap();
             cell.set(c, attrs);
+            // Plyloft: a lone VS16 is two wide though its own width is 0.
+            if width > 1 {
+                cell.set_wide(true);
+            }
             self.grid_mut().col_inc(1);
             if width > 1 {
                 let pos = self.grid().pos();
@@ -939,6 +1028,15 @@
                 self.grid_mut().col_inc(1);
             }
         }
+        // Plyloft (VENDORED.md): the cluster this character starts.
+        self.grapheme = (width > 0).then(|| {
+            let pos = self.grid().pos();
+            crate::grapheme::JoinState::start(
+                crate::grid::Pos { row: pos.row, col: pos.col - width },
+                c,
+                width,
+            )
+        });
     }
 
     // control codes
```
