/*
 * Facts checked 2026-09-03 against `man tmux` for tmux 3.4 on this machine
 * (`man tmux | col -b`, sections CLIENTS AND SESSIONS, WINDOWS AND PANES,
 * DEFAULT KEY BINDINGS, KEY BINDINGS, OPTIONS, BUFFERS, MISCELLANEOUS, EXIT
 * MESSAGES, FILES, EXAMPLES), the live key tables (`tmux list-keys -T
 * copy-mode` and `-T copy-mode-vi`), and every error string in the
 * troubleshooting section reproduced against a throwaway server
 * (`tmux -L probe …`) on 2026-09-03: "no server running on", "error
 * connecting to … (No such file or directory)", "no sessions", "can't find
 * session:", "duplicate session:", "sessions should be nested with care,
 * unset $TMUX to force", "open terminal failed: not a terminal", "missing or
 * unsuitable terminal:", "server exited unexpectedly", "Pane is dead".
 *
 * Not verified here and therefore stated as third-party: the tmux-resurrect
 * and tmux-continuum plugins (named, not described in detail).
 */

export type TmuxSectionId =
  | "sessions"
  | "windows"
  | "panes"
  | "copy-mode"
  | "prefix"
  | "tmux-conf"
  | "scripting"
  | "troubleshooting";

export interface TmuxSection {
  id: TmuxSectionId;
  /** The H2 — query-shaped, sentence case. */
  title: string;
  /** The short label in the jump row under the filter. */
  nav: string;
  /** One or two sentences under the heading. */
  lead: string;
}

export interface TmuxEntry {
  section: TmuxSectionId;
  /** What you are trying to do, or the error you are looking at. */
  task: string;
  /** The command, ready to copy. Newlines separate lines of a config or script. */
  command: string;
  /** The default key binding, prefix included, when there is one. */
  keys?: string;
  /** The one thing worth knowing; backticks mark code. */
  note?: string;
}

export const TMUX_SECTIONS: readonly TmuxSection[] = [
  {
    id: "sessions",
    nav: "Sessions",
    title: "tmux sessions: new, attach, detach, list, rename, kill.",
    lead: "A session is a set of windows kept alive by one tmux server. Detaching leaves it running; attaching picks it up from any terminal — as long as the server process is still there.",
  },
  {
    id: "windows",
    nav: "Windows",
    title: "tmux windows.",
    lead: "A window fills the screen and belongs to a session; the status line lists them by index. Think tabs.",
  },
  {
    id: "panes",
    nav: "Panes",
    title: "tmux panes: split, navigate, resize, zoom, swap, break and join.",
    lead: "A pane is a slice of a window, and each one is its own terminal. Splits, sizes, and layouts are per window.",
  },
  {
    id: "copy-mode",
    nav: "Copy mode and scrollback",
    title: "tmux copy mode and scrollback.",
    lead: "History lives in copy mode: enter it, move, select, copy. Text goes to tmux’s own paste buffers unless you tell it otherwise.",
  },
  {
    id: "prefix",
    nav: "Prefix and keys",
    title: "The tmux prefix and key bindings.",
    lead: "Every tmux keystroke starts with the prefix — C-b by default — released before the command key. Everything is rebindable.",
  },
  {
    id: "tmux-conf",
    nav: ".tmux.conf",
    title: ".tmux.conf essentials.",
    lead: "tmux reads ~/.tmux.conf or ~/.config/tmux/tmux.conf once, when the server starts. Lines are the same commands, minus the leading tmux.",
  },
  {
    id: "scripting",
    nav: "Scripting",
    title: "Scripting tmux: send-keys, run-shell, and building a workspace.",
    lead: "Every command takes a target. A script can drive a session it never attaches to, from cron, from a hook, from another machine over SSH.",
  },
  {
    id: "troubleshooting",
    nav: "Troubleshooting",
    title: "tmux troubleshooting: the messages and their fixes.",
    lead: "What tmux prints, what each line means, and the command that answers it.",
  },
];

export const TMUX_COMMANDS: readonly TmuxEntry[] = [
  // ─── sessions ───────────────────────────────────────────────────────────
  {
    section: "sessions",
    task: "Start tmux — a new session with one window",
    command: "tmux",
    note: "Attaches you to the new session at once. Its name is a number; give it a real one with `-s`.",
  },
  {
    section: "sessions",
    task: "Start a named session",
    command: "tmux new -s work",
    note: "`new` is the alias of `new-session`. The name is what every later `-t` target and `tmux ls` line uses.",
  },
  {
    section: "sessions",
    task: "Start a session in the background, running a command",
    command: "tmux new -d -s build 'make -j8'",
    note: "`-d` creates it detached, so this works from scripts and cron; the command runs in the first window.",
  },
  {
    section: "sessions",
    task: "Attach to the most recent session",
    command: "tmux attach",
    note: "`tmux a` also works — tmux accepts the shortest unambiguous form of any command.",
  },
  {
    section: "sessions",
    task: "Attach to a session by name",
    command: "tmux attach -t work",
  },
  {
    section: "sessions",
    task: "Attach, or create it if it doesn’t exist",
    command: "tmux new -A -s work",
    note: "`-A` makes new-session behave like attach-session when the name already exists. The one-liner for a login script.",
  },
  {
    section: "sessions",
    task: "Attach and kick every other client off",
    command: "tmux attach -d -t work",
    note: "`-d` detaches the other clients. The fix for a session that renders tiny because a terminal somewhere else is still attached.",
  },
  {
    section: "sessions",
    task: "Detach from the session",
    command: "tmux detach",
    keys: "C-b d",
    note: "The session keeps running on the server; you can close the terminal, drop the SSH connection, go home.",
  },
  {
    section: "sessions",
    task: "List sessions",
    command: "tmux ls",
    note: "Alias of `list-sessions`. With no server running it says so — see troubleshooting.",
  },
  {
    section: "sessions",
    task: "Check whether a session exists (for scripts)",
    command: "tmux has -t work",
    note: "Exit status 0 if it exists, 1 if not. Quiet enough for a shell `if`; redirect stderr to lose the message.",
  },
  {
    section: "sessions",
    task: "Rename the current session",
    command: "tmux rename -t 0 work",
    keys: "C-b $",
    note: "`rename` is the alias of `rename-session`; `-t` picks the session to rename.",
  },
  {
    section: "sessions",
    task: "Switch to another session while attached",
    command: "tmux switch-client -t work",
    keys: "C-b s · C-b ( · C-b ) · C-b L",
    note: "`C-b s` opens a chooser; `(` and `)` step to the previous and next session; `L` goes back to the last one.",
  },
  {
    section: "sessions",
    task: "Kill one session",
    command: "tmux kill-session -t work",
    note: "Closes its windows and detaches its clients. Other sessions are untouched.",
  },
  {
    section: "sessions",
    task: "Kill every session except one",
    command: "tmux kill-session -a -t work",
    note: "`-a` inverts the target: everything but `work` goes.",
  },
  {
    section: "sessions",
    task: "Kill all sessions",
    command: "tmux kill-server",
    note: "Kills the server, and with it every session and client. The one-line answer to “kill all tmux sessions”. There is no undo.",
  },
  {
    section: "sessions",
    task: "Exit tmux for good",
    command: "exit",
    keys: "C-d",
    note: "Typing `exit` in the last shell closes its window; when the last window of the last session closes, the server exits on its own.",
  },

  // ─── windows ────────────────────────────────────────────────────────────
  {
    section: "windows",
    task: "New window",
    command: "tmux neww -n logs",
    keys: "C-b c",
    note: "`-n` names it. Without a name the status line shows the running program.",
  },
  {
    section: "windows",
    task: "New window in a directory, running a command",
    command: "tmux neww -c ~/proj -n dev 'npm run dev'",
  },
  {
    section: "windows",
    task: "Next or previous window",
    command: "tmux next",
    keys: "C-b n · C-b p · C-b l",
    note: "`tmux prev` goes the other way; `C-b l` (`tmux last`) goes back to the window you came from. `M-n` and `M-p` after the prefix jump to the next window with activity or a bell.",
  },
  {
    section: "windows",
    task: "Jump to a window by number",
    command: "tmux selectw -t 2",
    keys: "C-b 0 … C-b 9",
    note: "Past nine, `C-b '` prompts for an index.",
  },
  {
    section: "windows",
    task: "Rename the window",
    command: "tmux renamew logs",
    keys: "C-b ,",
  },
  {
    section: "windows",
    task: "Choose a session, window, or pane from a tree",
    command: "tmux choose-tree",
    keys: "C-b w",
    note: "Everything on the server in one list; Enter jumps to it.",
  },
  {
    section: "windows",
    task: "Move the window to another index",
    command: "tmux movew -t 0",
    keys: "C-b .",
    note: "Errors if the index is taken; `-k` replaces whatever is there.",
  },
  {
    section: "windows",
    task: "Renumber windows to close the gaps",
    command: "tmux movew -r",
    note: "Respects `base-index`. To have it happen every time a window closes, set `renumber-windows on` (below).",
  },
  {
    section: "windows",
    task: "Kill the window",
    command: "tmux killw -t logs",
    keys: "C-b &",
    note: "The key binding asks for confirmation; the command doesn’t. `killw -a` kills every window but this one.",
  },

  // ─── panes ──────────────────────────────────────────────────────────────
  {
    section: "panes",
    task: "Split left and right",
    command: "tmux splitw -h",
    keys: "C-b %",
    note: "`-h` is what tmux calls a horizontal split: the new pane appears beside the current one.",
  },
  {
    section: "panes",
    task: "Split top and bottom",
    command: "tmux splitw -v",
    keys: 'C-b "',
    note: "`-v` is the default when neither flag is given.",
  },
  {
    section: "panes",
    task: "Split with a size, or on the other side",
    command: "tmux splitw -h -l 30%",
    note: "`-l` takes lines or columns, or a percentage of the space. `-b` puts the new pane to the left of, or above, the current one; `-c ~/proj` starts it in a directory, and a trailing `'tail -f app.log'` runs a command instead of a shell.",
  },
  {
    section: "panes",
    task: "Make splits open in the current pane’s directory",
    command:
      'bind \'"\' splitw -v -c "#{pane_current_path}"\nbind % splitw -h -c "#{pane_current_path}"',
    note: "For .tmux.conf. By default a new pane starts where the session started, not where you are.",
  },
  {
    section: "panes",
    task: "Move between panes",
    command: "tmux selectp -L",
    keys: "C-b ← ↑ → ↓",
    note: "`-L -R -U -D` pick a direction; `-t 2` picks a pane by number.",
  },
  {
    section: "panes",
    task: "Cycle panes, or go back to the last one",
    command: "tmux lastp",
    keys: "C-b o · C-b ;",
  },
  {
    section: "panes",
    task: "Show pane numbers, then jump to one",
    command: "tmux displayp",
    keys: "C-b q, then a digit",
    note: "The numbers stay up for `display-panes-time` milliseconds; pressing one runs `select-pane` on it.",
  },
  {
    section: "panes",
    task: "Resize a pane",
    command: "tmux resizep -L 10",
    keys: "C-b C-← … (one cell) · C-b M-← … (five)",
    note: "`-U -D -L -R` with a count; `-x 50%` or `-y 20` set an absolute size in cells or percent.",
  },
  {
    section: "panes",
    task: "Zoom a pane to fill the window (toggle)",
    command: "tmux resizep -Z",
    keys: "C-b z",
  },
  {
    section: "panes",
    task: "Swap with the previous or next pane",
    command: "tmux swapp -U",
    keys: "C-b { · C-b }",
    note: "`-D` swaps downward. Mark a pane first with `C-b m` and it becomes the source.",
  },
  {
    section: "panes",
    task: "Cycle through the preset layouts",
    command: "tmux selectl tiled",
    keys: "C-b Space",
    note: "Presets: even-horizontal, even-vertical, main-horizontal, main-vertical, tiled — also on `C-b M-1` to `M-5`.",
  },
  {
    section: "panes",
    task: "Break a pane out into its own window",
    command: "tmux breakp",
    keys: "C-b !",
  },
  {
    section: "panes",
    task: "Join a pane from another window",
    command: "tmux joinp -s :2",
    note: "Moves window 2’s active pane into the current window, below the current pane; `-h` puts it beside. The reverse of `break-pane`.",
  },
  {
    section: "panes",
    task: "Mark a pane, then join it wherever you are",
    command: "tmux joinp",
    keys: "C-b m",
    note: "With `-s` omitted, `join-pane`, `swap-pane` and `move-pane` use the marked pane. `C-b M` clears the mark.",
  },
  {
    section: "panes",
    task: "Kill the pane",
    command: "tmux killp",
    keys: "C-b x",
    note: "`-a` kills every other pane in the window instead.",
  },
  {
    section: "panes",
    task: "Type into every pane at once",
    command: "tmux setw synchronize-panes on",
    note: "A window option; `off` to stop. The same command on four servers, once.",
  },
  {
    section: "panes",
    task: "Keep a pane after its command exits, then restart it",
    command: "tmux setw remain-on-exit on\ntmux respawnp -k",
    note: "The pane shows “Pane is dead” instead of vanishing. `respawn-pane` reruns its original command; `-k` kills anything still there.",
  },

  // ─── copy mode and scrollback ───────────────────────────────────────────
  {
    section: "copy-mode",
    task: "Enter copy mode (scroll back)",
    command: "tmux copy-mode",
    keys: "C-b [",
    note: "`C-b PageUp` enters it already scrolled up one page.",
  },
  {
    section: "copy-mode",
    task: "Leave copy mode",
    command: "tmux send-keys -X cancel",
    keys: "q · Escape (emacs)",
    note: "`-X` sends a copy-mode command to the pane, which is how the key tables are built.",
  },
  {
    section: "copy-mode",
    task: "Page up and down",
    command: "tmux send-keys -X page-up",
    keys: "PageUp · PageDown · vi adds C-b, C-f",
    note: "Half pages: `C-u` and `C-d` in vi mode, `M-Up` and `M-Down` in emacs mode.",
  },
  {
    section: "copy-mode",
    task: "Top or bottom of the history",
    command: "tmux send-keys -X history-top",
    keys: "g · G (vi) · M-< · M-> (emacs)",
  },
  {
    section: "copy-mode",
    task: "Search backwards or forwards",
    command: "tmux send-keys -X search-backward error",
    keys: "? · / (vi) · C-r · C-s (emacs)",
    note: "`n` repeats the search, `N` reverses it. The way to find the error that scrolled past.",
  },
  {
    section: "copy-mode",
    task: "Start a selection",
    command: "tmux send-keys -X begin-selection",
    keys: "Space (vi) · C-Space (emacs)",
    note: "`v` (vi) or `R` (emacs) toggles a rectangle; `V` (vi) selects whole lines.",
  },
  {
    section: "copy-mode",
    task: "Copy the selection and leave copy mode",
    command: "tmux send-keys -X copy-selection-and-cancel",
    keys: "Enter (vi) · M-w (emacs)",
    note: "The text lands in a tmux paste buffer, not the system clipboard — see `set-clipboard` below.",
  },
  {
    section: "copy-mode",
    task: "Paste the last buffer",
    command: "tmux pasteb",
    keys: "C-b ]",
  },
  {
    section: "copy-mode",
    task: "List buffers, or pick one to paste",
    command: "tmux lsb",
    keys: "C-b # · C-b =",
    note: "`=` opens a chooser so you can paste any buffer, not only the newest.",
  },
  {
    section: "copy-mode",
    task: "Dump the whole scrollback to a file",
    command: "tmux capture-pane -p -J -S - > pane.txt",
    note: "`-p` prints to stdout, `-S -` starts at the beginning of history, `-J` joins wrapped lines. `-t work:0.1` targets another pane.",
  },
  {
    section: "copy-mode",
    task: "Scroll with the mouse wheel",
    command: "set -g mouse on",
    note: "Off by default. With it on, the wheel enters copy mode and scrolls, a drag selects, and letting go copies.",
  },
  {
    section: "copy-mode",
    task: "Keep more scrollback",
    command: "set -g history-limit 50000",
    note: "Lines per pane. Applies only to windows created afterwards — existing windows keep the limit they were born with.",
  },
  {
    section: "copy-mode",
    task: "Copy into the system clipboard",
    command: "set -g set-clipboard on",
    note: "Uses the xterm clipboard escape, so the terminal has to support it and say so in terminfo (the `Ms` entry). Over SSH it is the one route that needs nothing installed on the far side. Otherwise pipe: `bind -T copy-mode-vi y send-keys -X copy-pipe-and-cancel 'xclip -selection clipboard'`.",
  },

  // ─── the prefix and key bindings ────────────────────────────────────────
  {
    section: "prefix",
    task: "The prefix key",
    command: "set -g prefix C-b",
    keys: "C-b",
    note: "Press Ctrl-b, let go, then the command key. `C-b C-b` sends a literal Ctrl-b to the program in the pane — or to an inner tmux.",
  },
  {
    section: "prefix",
    task: "List every key binding",
    command: "tmux lsk -N",
    keys: "C-b ?",
    note: "`-N` shows only keys with notes, the readable version. Plain `lsk` prints bind-key lines you can paste into a config.",
  },
  {
    section: "prefix",
    task: "The command prompt",
    command: ":kill-server",
    keys: "C-b :",
    note: "Any command on this page works there without the leading `tmux`.",
  },
  {
    section: "prefix",
    task: "Bind a key",
    command: "bind r source-file ~/.tmux.conf",
    note: "Keys go in the prefix table unless you say otherwise, so this is `C-b r`. `-N 'reload'` attaches a note for `lsk -N`.",
  },
  {
    section: "prefix",
    task: "Bind a key that needs no prefix",
    command: "bind -n M-Left selectp -L",
    note: "`-n` binds in the root table: the key acts on its own. Pick keys the programs in your panes don’t use.",
  },
  {
    section: "prefix",
    task: "Bind a key that repeats",
    command: "bind -r H resizep -L 5",
    note: "`-r` lets you press the prefix once and `H` several times within `repeat-time` milliseconds (500 by default).",
  },
  {
    section: "prefix",
    task: "Unbind a key",
    command: "unbind C-b",
    note: "`unbind -a` removes every binding — only in a config that rebinds what you need.",
  },

  // ─── .tmux.conf essentials ──────────────────────────────────────────────
  {
    section: "tmux-conf",
    task: "Where the config lives",
    command: "~/.tmux.conf\n~/.config/tmux/tmux.conf",
    note: "Either path; `/etc/tmux.conf` applies to everyone. Read once, when the server starts.",
  },
  {
    section: "tmux-conf",
    task: "Reload the config without restarting",
    command: "tmux source ~/.tmux.conf",
    keys: "C-b : source ~/.tmux.conf",
    note: "Options apply at once. Per-window settings such as `history-limit` only reach windows created afterwards.",
  },
  {
    section: "tmux-conf",
    task: "Turn the mouse on",
    command: "set -g mouse on",
    note: "Click to select panes and windows, drag borders to resize, wheel to scroll.",
  },
  {
    section: "tmux-conf",
    task: "Remap the prefix to C-a (screen style)",
    command: "set -g prefix C-a\nunbind C-b\nbind C-a send-prefix",
    note: "The three lines from the man page’s own example. C-a is readline’s beginning-of-line; press it twice to send it through.",
  },
  {
    section: "tmux-conf",
    task: "vi keys in copy mode",
    command: "setw -g mode-keys vi",
    note: "The default is emacs unless `$VISUAL` or `$EDITOR` contains `vi`. `set -g status-keys vi` does the same at the command prompt.",
  },
  {
    section: "tmux-conf",
    task: "Number windows and panes from 1",
    command: "set -g base-index 1\nsetw -g pane-base-index 1",
    note: "So `C-b 1` is the leftmost window — 0 is a long reach.",
  },
  {
    section: "tmux-conf",
    task: "Renumber windows when one closes",
    command: "set -g renumber-windows on",
  },
  {
    section: "tmux-conf",
    task: "Kill the Escape delay (for vim)",
    command: "set -s escape-time 10",
    note: "tmux waits `escape-time` milliseconds after Escape (500 by default) to see whether a meta sequence follows; vim users feel every one of them.",
  },
  {
    section: "tmux-conf",
    task: "True colour and the right TERM",
    command:
      'set -g default-terminal "tmux-256color"\nset -as terminal-features ",xterm-256color:RGB"',
    note: "`default-terminal` must be `screen`, `tmux`, or a derivative. `RGB` tells tmux the outer terminal — matched by its TERM — speaks 24-bit colour; `-as` appends to the array option.",
  },
  {
    section: "tmux-conf",
    task: "Keep the window size sensible with several clients",
    command: "set -g window-size latest",
    note: "Size follows the client that last did something, instead of the smallest attached one.",
  },

  // ─── scripting ──────────────────────────────────────────────────────────
  {
    section: "scripting",
    task: "Type into a session from outside",
    command: "tmux send-keys -t work 'npm test' Enter",
    note: "Arguments are key names (`Enter`, `C-c`, `Escape`) or literal text, so `send-keys -t work:0.1 C-c` interrupts a pane. Targets are `session:window.pane`; drop parts from the right to mean “the current one”. Nobody needs to be attached.",
  },
  {
    section: "scripting",
    task: "Read what a pane is showing",
    command: "tmux capture-pane -p -t work",
    note: "The programmatic `tail`: what is on screen right now, as text. Add `-S -` for the whole history.",
  },
  {
    section: "scripting",
    task: "Print a value from tmux",
    command: "tmux display -p '#{pane_current_path}'",
    note: "`#{…}` is a format; the FORMATS section of the man page lists hundreds — `session_name`, `pane_pid`, `window_active` …",
  },
  {
    section: "scripting",
    task: "Run a shell command from tmux",
    command: "tmux run-shell 'notify-send \"build done\"'",
    note: "`-b` runs it in the background, `-d 5` waits five seconds first. From a key binding, the output opens in view mode.",
  },
  {
    section: "scripting",
    task: "Log a pane to a file",
    command: "tmux pipe-pane -o 'cat >> ~/pane.log'",
    note: "`-o` toggles: run it again to stop. Output only, unless you ask for input with `-I`.",
  },
  {
    section: "scripting",
    task: "Bring up a whole workspace from a script",
    command:
      "tmux new -d -s dev -n editor -c ~/proj 'vim'\ntmux splitw -t dev:editor -h -c ~/proj\ntmux neww -t dev -n logs -c ~/proj 'tail -f log/dev.log'\ntmux selectw -t dev:editor\ntmux attach -t dev",
    note: "Every line is a command with a target; the last hands the finished session to your terminal. Guard it with `tmux has -t dev 2>/dev/null || …` to make it safe to rerun.",
  },
  {
    section: "scripting",
    task: "A separate server for something you don’t want touched",
    command: "tmux -L agents new -d -s claude",
    note: "`-L` names a socket in `/tmp/tmux-UID/`; `-S` gives a full path. Every later command needs the same `-L`, and `kill-server` on one leaves the other alone.",
  },

  // ─── troubleshooting ────────────────────────────────────────────────────
  {
    section: "troubleshooting",
    task: "“no server running on /tmp/tmux-1000/default”",
    command: "tmux new -A -s main",
    note: "Nothing to list or attach to: there is no tmux server for your user. `attach` says “no sessions” for the same reason. After a reboot this is normal — the server was a process, and it is gone. `new -A` creates or attaches, whichever applies.",
  },
  {
    section: "troubleshooting",
    task: "“error connecting to /tmp/tmux-1000/default (No such file or directory)”",
    command: "tmux new -s main",
    note: "The same thing before the socket directory even exists — first run on a machine, or after `/tmp` was cleaned. Start a session and the directory appears.",
  },
  {
    section: "troubleshooting",
    task: "Sessions gone after a reboot",
    command: "tmux new -d -s main",
    note: "tmux keeps sessions in a process, not on disk; a reboot ends the process and everything in it. The third-party tmux-resurrect and tmux-continuum plugins save and restore layouts and the commands that were running (not their state); a login script or systemd user unit can recreate your standard session with this line.",
  },
  {
    section: "troubleshooting",
    task: "“sessions should be nested with care, unset $TMUX to force”",
    command: "tmux -L inner new -s x",
    note: "You ran `tmux` inside a tmux pane. Usually you meant `tmux attach` from a plain shell, or `switch-client` from inside. For a real tmux-in-tmux, give the inner one its own socket with `-L`, and remember `C-b C-b` sends the prefix through to it.",
  },
  {
    section: "troubleshooting",
    task: "“open terminal failed: not a terminal”",
    command: "ssh -t host tmux attach",
    note: "tmux needs a tty and didn’t get one: `ssh host tmux` without `-t`, a cron job, a CI step, a pipeline. Force a tty with `ssh -t`, or start detached with `new -d`, which needs no terminal at all.",
  },
  {
    section: "troubleshooting",
    task: "“missing or unsuitable terminal: xterm-kitty”",
    command: "TERM=xterm-256color tmux attach",
    note: "The host has no terminfo entry for your terminal’s `$TERM` (older releases print it as `open terminal failed: missing or unsuitable terminal`). Set a `TERM` the host knows for that one command, or install your terminal’s terminfo on the host.",
  },
  {
    section: "troubleshooting",
    task: "“duplicate session: work”",
    command: "tmux attach -t work",
    note: "`new -s work` when `work` already exists. Attach instead — or use `new -A -s work`, which does whichever is right.",
  },
  {
    section: "troubleshooting",
    task: "“can't find session: work”",
    command: "tmux ls",
    note: "A typo, a different socket (`-L`), or a different user — sessions belong to the user whose server holds them, and `sudo tmux` is a different user.",
  },
  {
    section: "troubleshooting",
    task: "The session shows in a small box with dots around it",
    command: "tmux attach -d -t work",
    note: "Another client is attached from a smaller terminal and the window is sized to fit it. `-d` detaches the others; `set -g window-size latest` stops it recurring.",
  },
  {
    section: "troubleshooting",
    task: "Colours look wrong inside tmux",
    command: 'set -g default-terminal "tmux-256color"',
    note: "Plus the `terminal-features` RGB line above. `tmux display -p '#{client_termfeatures}'` shows what tmux decided about your terminal.",
  },
  {
    section: "troubleshooting",
    task: "Copy doesn’t reach the clipboard over SSH",
    command: "set -g set-clipboard on",
    note: "Needs a terminal that accepts the xterm clipboard escape. Otherwise pipe copies to a clipboard tool with `copy-pipe-and-cancel`, or use the terminal’s own selection — many terminals bypass tmux’s mouse capture while Shift is held.",
  },
  {
    section: "troubleshooting",
    task: "A pane says “Pane is dead”",
    command: "tmux respawnp -k",
    note: "Its command exited and `remain-on-exit` kept the pane. Respawn it, or `killp`.",
  },
  {
    section: "troubleshooting",
    task: "Ctrl-b doesn’t do anything",
    command: "tmux show -g prefix",
    note: "Something remapped the prefix — a dotfile, a plugin, a colleague. Ask tmux what it is now; `tmux lsk -N` lists the live bindings.",
  },
];
