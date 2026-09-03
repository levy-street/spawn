import type { ArticleEntry } from "../types";

/*
 * SSH from a phone (grimoire play 4): iPhone, iPad, Android, and the Windows client roundup.
 * Pure data on the article template; see definitions.ts for the exemplar.
 *
 * Facts checked 2026-09-03 against:
 *   Termius     https://termius.com/pricing
 *               https://docs.termius.com/keychain/ssh-keys-and-certificates
 *               https://docs.termius.com/organize-and-connect-to-hosts/connecting-to-a-server
 *               https://docs.termius.com/terminal/mobile-terminal.md
 *               https://play.google.com/store/apps/details?id=com.server.auditor.ssh.client
 *   Blink Shell https://blink.sh/  https://github.com/blinksh/blink
 *               https://docs.blink.sh/basics/ssh-keys  https://docs.blink.sh/basics/customize
 *               https://docs.blink.sh/advanced/advanced-ssh
 *   Prompt 3    https://panic.com/prompt/  https://help.panic.com/prompt/purchase-faq/
 *   ShellFish   https://secureshellfish.app/
 *               https://apps.apple.com/us/app/ssh-files-secure-shellfish/id1336634154
 *   a-Shell     https://apps.apple.com/us/app/a-shell/id1473805438
 *               https://github.com/holzschu/a-shell  https://github.com/holzschu/ios_system
 *   Termux      https://github.com/termux/termux-app  https://f-droid.org/en/packages/com.termux/
 *               https://github.com/termux/termux-packages (packages/openssh, packages/mosh, wiki)
 *               https://github.com/termux/termux-tools/blob/master/termux.properties
 *               https://github.com/termux/termux-app/issues/584 (wakelock in the notification)
 *   ConnectBot  https://connectbot.org/  https://github.com/connectbot/connectbot
 *               https://f-droid.org/packages/org.connectbot/
 *   JuiceSSH    https://play.google.com/store/apps/details?id=com.sonelli.juicessh (HTTP 404)
 *               https://juicessh.com/changelog (connection refused)
 *   Tailscale   https://tailscale.com/pricing  https://tailscale.com/kb/1193/tailscale-ssh
 *               https://tailscale.com/kb/1020/install-ios  https://tailscale.com/docs/install/android
 *   mosh        https://mosh.org/
 *   tmux        https://github.com/tmux/tmux/wiki/Getting-Started
 *   Apple       https://support.apple.com/en-us/105075 (Stage Manager, external display models)
 *   Samsung     https://www.samsung.com/us/apps/dex/
 *   Android     https://dontkillmyapp.com/
 *   Windows     https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-overview
 *               https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse
 *               https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement
 *               https://learn.microsoft.com/en-us/windows/terminal/install
 *               https://devblogs.microsoft.com/commandline/windows-terminal-is-now-the-default-in-windows-11/
 *               https://learn.microsoft.com/en-us/windows/wsl/install
 *   PuTTY       https://www.chiark.greenend.org.uk/~sgtatham/putty/ (licence.html, wishlist/#multiple-connections)
 *   KiTTY       https://github.com/cyd01/KiTTY  https://www.9bis.net/kitty/
 *   MobaXterm   https://mobaxterm.mobatek.net/download.html  https://mobaxterm.mobatek.net/documentation.html
 *               https://mobaxterm.mobatek.net/features.html
 *   Tabby       https://github.com/Eugeny/tabby
 *   Bitvise     https://bitvise.com/ssh-client  https://bitvise.com/ssh-client-pricing
 *               https://bitvise.com/ssh-client-putty-openssh-auth-agents
 *
 * Not verifiable on a vendor page, so not stated: JuiceSSH's last release date (its
 * site refused connections); whether Bitvise's terminal is tabbed; MobaXterm's SSH
 * agent; ShellFish and mosh (its pages don't mention it). The Termux wiki blocks
 * fetches, so `pkg` syntax comes from the termux-packages wiki and the package tree.
 */

export const PHONE_SSH: ArticleEntry[] = [
  {
    slug: "ssh-from-iphone",
    kind: "guide",
    hub: { name: "Guides", href: "/guides" },
    title: "SSH from an iPhone: clients, keys, and staying connected",
    description:
      "How to SSH from an iPhone in 2026: which iOS SSH client to pick, where the keys live, how to reach the host, and how to keep a session alive when the screen locks.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "SSH from an",
      accent: "iPhone",
      sub: "A real terminal on the phone in your pocket — the client to pick, the key ceremony, the reachability question, and the honest answer to what a phone can’t do.",
    },
    body: [
      {
        kind: "prose",
        heading: "What an iOS SSH client actually is.",
        paragraphs: [
          "An SSH client on an iPhone is a complete client: it holds your keys, negotiates the connection, and draws a terminal on a screen that was never meant for one. The good ones — Termius, Blink Shell, Prompt 3, Secure ShellFish — are mature, and the differences between them are mostly about money, keys, and how they cope with the two things iOS does to every app: suspend it when you switch away, and give it a keyboard with no Esc, Ctrl, or Tab.",
          "So the route has five parts, and none is optional. Pick a client. Get a key onto the phone and its public half onto the host. Make the host reachable from a cellular network. Make the session survive the phone. Then live with the keyboard. What follows is that route, honestly, before the question of whether the phone needs an SSH client at all.",
        ],
      },
      {
        kind: "table",
        heading: "The iOS clients, side by side.",
        lead: "Prices are from each vendor’s own page as of September 2026; check them, because the subscriptions move.",
        columns: ["Client", "Price", "Keys", "Mosh", "Best for"],
        rows: [
          [
            "Termius",
            "Starter is free; Pro is $10/month billed annually, for sync",
            "Generates Ed25519, ECDSA, RSA; Face ID keys in the Secure Enclave on Pro",
            "Yes",
            "One client on phone, desktop, and Android, hosts synced",
          ],
          [
            "Blink Shell",
            "Two weeks free, then $19.99/year; GPL-3.0 source",
            "Ed25519, ECDSA, RSA, or Secure Enclave keys that never leave the chip",
            "Yes",
            "Keyboard-first power use; mosh that survives sleep",
          ],
          [
            "Prompt 3",
            "$9.99/year or $49 once; 7-day trial; Mac, iPad, iPhone, Vision Pro",
            "Synced by Panic Sync; favorites locked with Face ID and the Secure Enclave",
            "Yes, plus Eternal Terminal",
            "One licence across every Apple screen",
          ],
          [
            "Secure ShellFish",
            "Free to try; $2.99/month, $14.99/year, or $29.99 for life",
            "Secure Enclave keys, hardware security keys, SSH certificates",
            "Not advertised",
            "Your server’s files in the Files app and in Shortcuts",
          ],
          [
            "a-Shell",
            "Free; BSD-3 source",
            "ssh-keygen on the phone, as on a Mac",
            "No",
            "A local Unix shell that also has ssh and scp",
          ],
        ],
      },
      {
        kind: "steps",
        heading: "The route, step by step.",
        steps: [
          {
            title: "Pick the client and install it",
            body: "If you want one app everywhere and don’t mind a subscription for sync, Termius. If you live in the terminal and own a Bluetooth keyboard, Blink. If you already use a Mac and an iPad and want one licence, Prompt 3. If what you actually want is the server’s files in the Files app, ShellFish. Every one of them is free to try, so try two.",
          },
          {
            title: "Make a key on the phone; only the public half leaves it",
            body: "Don’t AirDrop your laptop’s private key. Generate a new one in the app — Blink under `config` → Keys → Generate New, Termius under Keychain → New key — and prefer Ed25519. Blink and Termius can also make the key inside the Secure Enclave, which means it cannot be exported or synced, and that is the point: a stolen phone yields nothing to copy. Then append the public key to `~/.ssh/authorized_keys` on the host; Blink ships [ssh-copy-id](https://docs.blink.sh/basics/ssh-keys) for exactly this.",
            code: {
              caption: "From Blink, naming the key you generated",
              lines: ["ssh-copy-id -i phone-key user@host"],
            },
          },
          {
            title: "Make the host reachable from a cellular network",
            body: "On the same Wi‑Fi, `ssh user@192.168.1.20` just works. Anywhere else, something has to carry the connection. The clean answer is a tailnet: install [Tailscale on the phone](https://tailscale.com/kb/1020/install-ios) and on the host, and the host gets a stable name that resolves from any network; the personal plan is free. [Tailscale SSH](https://tailscale.com/kb/1193/tailscale-ssh) can even replace the key ceremony, though its server side runs only on Linux and, through the open-source tailscaled, macOS. The old answer is a port forward on the router to port 22 — it works, and it puts sshd on the public internet, so if you take it, key-only authentication is not optional.",
          },
          {
            title: "Keep the session alive with tmux, and the channel alive with mosh",
            body: "Two different problems. tmux keeps the shell running on the host when the connection dies: start work inside `tmux new -s work` and reattach with `tmux attach -t work` from any device. mosh keeps the connection itself alive as the phone hops from Wi‑Fi to cellular to sleep — it rides UDP ports 60000–61000 after an SSH handshake, so those must be open wherever port 22 is, and it syncs only the visible screen, which is why [mosh.org](https://mosh.org/) itself tells you to run tmux underneath. Blink, Termius, and Prompt 3 all speak it.",
            code: {
              caption: "On the host once, then from the phone",
              lines: [
                "sudo apt-get install mosh tmux",
                "mosh user@host",
                "tmux attach -t work || tmux new -s work",
              ],
            },
          },
          {
            title: "Tame the phone",
            body: "The keyboard has no Esc, Ctrl, Tab, or arrows, so every client adds a row above it — Termius calls it the keyboard add-on and lets you reorder its groups; Blink’s gestures and remaps live under [customize](https://docs.blink.sh/basics/customize). Pinch to change the font size. Turn auto-lock up while you work, because iOS suspends a backgrounded app and a plain SSH connection rarely survives the lock screen; mosh does, which is most of why the paid clients bother with it. And accept the geometry: a phone-width terminal is for checking on work, not for the work.",
          },
        ],
      },
      {
        kind: "points",
        heading: "Where the route wears thin.",
        lead: "None of this is a defect in the apps. It is the shape of SSH, worn on a phone.",
        items: [
          {
            title: "A key per device",
            body: "Every phone, tablet, and laptop gets its own key, its public half copied to every host, and its removal — when the phone is lost — means editing authorized_keys on each of them, from something that still has access.",
          },
          {
            title: "A host that must be reachable",
            body: "sshd has to be on the LAN, on a tailnet, or on the public internet. The tailnet is the good answer, and it is one more agent on every machine and one more app on the phone.",
          },
          {
            title: "Persistence as a discipline",
            body: "The session survives only what you started inside tmux. Forget once and a two-hour job dies with the lock screen.",
          },
          {
            title: "The screen you arrive at",
            body: "You land on a prompt, not on the work. Finding the session, the pane, and the question an agent asked an hour ago is scrolling with a thumb.",
          },
        ],
      },
      {
        kind: "prose",
        heading: "Or skip SSH entirely.",
        paragraphs: [
          "For servers you don’t control, the SSH app is the right tool and the route above is how to use it. For machines that are yours — the workstation, the Mac mini, the build box — there is a shape with no client at all. spawnd installs one daemon on each host you own; the daemon dials out, so nothing on the host listens, no port is forwarded, no VPN is needed. The phone opens a browser, installs the console to the home screen as a web app, and is approved once against a short code. There is no key on the phone to generate, copy, or revoke; revoking the device is one click that every host honors.",
          "The sessions are different too. Each one is owned by a worker process on the host, so it survives the closed tab, the dropped connection, the laptop lid, and a daemon restart, scrollback intact — there is no tmux to remember. And what the phone opens onto is the standing work: one workspace per project, a grid of sessions across hosts, an attention cue when an agent is waiting on a yes, and a notification on the phone so you don’t have to keep checking. Your browser talks to each daemon peer-to-peer, end-to-end encrypted; the server that introduces them never sees session content. It is open source, MIT/Apache-2.0. [Termius alternatives](/termius-alternatives) ranks the clients beside the route that needs none, and [Claude Code, remote](/claude-code-remote) covers the agent side: the official ways to reach a running Claude Code, and the machines they leave out.",
        ],
      },
    ],
    start: "One line on the host, nothing on the phone.",
    faq: [
      {
        q: "What is the best free SSH client for iPhone?",
        a: "Termius’ Starter plan is free and includes SSH, SFTP, and port forwarding; a-Shell is free and open source with ssh and scp built in. Blink and Prompt 3 are paid after a trial, and both earn it if you use the phone terminal daily.",
      },
      {
        q: "Why does my SSH session drop when I lock my iPhone?",
        a: "iOS suspends apps in the background, and a plain SSH connection doesn’t survive that. Use mosh, which reconnects transparently, and run tmux on the host so the shell itself is never lost.",
      },
      {
        q: "Do I have to open a port on my router to SSH from my phone?",
        a: "No. A tailnet such as Tailscale reaches the host from any network without a forwarded port. spawnd takes the other route: the host dials out and nothing on it listens, so there is no port to open and no VPN to run.",
      },
    ],
    related: [
      {
        title: "Termius alternatives",
        blurb: "Eight clients ranked honestly, and the route that needs no client at all.",
        href: "/termius-alternatives",
      },
      {
        title: "Claude Code, remote",
        blurb: "Remote Control, the web, and SSH + tmux — then the machines they leave out.",
        href: "/claude-code-remote",
      },
      {
        title: "SSH on an iPad",
        blurb: "the same route with a real keyboard and a bigger screen",
        href: "/ssh-from-ipad",
      },
    ],
    cardTitle: "SSH from an iPhone",
    cardBlurb:
      "The client, the key, the reachability, the tmux — and the route with no client at all.",
  },

  {
    slug: "ssh-from-ipad",
    kind: "guide",
    hub: { name: "Guides", href: "/guides" },
    title: "SSH on an iPad: the setup that makes it a dev machine",
    description:
      "SSH on an iPad, done properly: the clients compared, keys, the hardware keyboard, Stage Manager and an external display, and what ‘dev machine’ honestly means.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "SSH on an",
      accent: "iPad",
      sub: "The iPad becomes a development machine the moment it has a terminal to a real one. Here is how to set that up well, and where it stops being enough.",
    },
    body: [
      {
        kind: "prose",
        heading: "What a dev machine on an iPad honestly means.",
        paragraphs: [
          "iPadOS will not run your toolchain. There is no Docker, no system shell, no way to install the Node or Rust or Python your project actually needs — a-Shell runs Python and C locally, and that is impressive, but it is not your repository. So every serious “code on an iPad” setup is the same thing underneath: a terminal on the iPad, and a real computer somewhere else doing the work. That is not a compromise to apologise for. A 13-inch iPad with a Magic Keyboard, a good SSH client, and a Mac mini at home is a better development machine than most laptops, because the heavy part never runs on battery.",
          "What makes it good is everything around the terminal: a hardware keyboard with Esc where your fingers expect it, windows you can arrange, a session that is still there tomorrow, and a host you can reach from a café. Those are the steps below.",
        ],
      },
      {
        kind: "table",
        heading: "The iPad clients.",
        lead: "The same apps as on the iPhone, weighed for what the bigger screen and the keyboard bring out. Prices from the vendors’ pages, September 2026.",
        columns: ["Client", "Price", "Keys", "Mosh", "On the iPad"],
        rows: [
          [
            "Blink Shell",
            "Two weeks free, then $19.99/year; GPL-3.0 source",
            "Ed25519, ECDSA, RSA, or Secure Enclave",
            "Yes",
            "Caps as Esc-and-Ctrl remaps, Split View, output to a 4K external display",
          ],
          [
            "Termius",
            "Starter free; Pro $10/month billed annually",
            "Generated in app; Face ID keys in the Secure Enclave on Pro",
            "Yes",
            "The hotkey bar hides itself when a hardware keyboard connects; hosts synced with the desktop",
          ],
          [
            "Prompt 3",
            "$9.99/year or $49 once — one licence for Mac, iPad, iPhone, Vision Pro",
            "Panic Sync; Face ID and Secure Enclave lock",
            "Yes, plus Eternal Terminal",
            "The same app and servers on the Mac beside it",
          ],
          [
            "Secure ShellFish",
            "Free to try; $14.99/year or $29.99 for life",
            "Secure Enclave, security keys, certificates",
            "Not advertised",
            "The host’s files in the Files app; drag-and-drop into other iPad apps",
          ],
        ],
      },
      {
        kind: "steps",
        heading: "Set it up.",
        steps: [
          {
            title: "Install the client and make a key on the iPad",
            body: "Generate the key on the device, never copy one over. In Blink, `config` → Keys → Generate New; in Termius, Keychain → New key. Choose Ed25519, or a Secure Enclave key if you want one that cannot leave the iPad. Copy the public half to the host — Blink’s `ssh-copy-id` does it in one line — and the [iPhone guide](/ssh-from-iphone) has the longer version.",
            code: { lines: ["ssh-copy-id -i ipad-key user@host"] },
          },
          {
            title: "Reach the host from anywhere",
            body: "On home Wi‑Fi, `ssh user@host.local`. Elsewhere, put the iPad and the host on a tailnet — [Tailscale’s iPad app](https://tailscale.com/kb/1020/install-ios) is the same as the iPhone one, and the personal plan is free — or forward port 22 on the router and accept that sshd is now public. The tailnet is the answer for almost everyone.",
          },
          {
            title: "Fix the keyboard first",
            body: "Many iPad keyboards have no Esc key. Blink lets you make Caps Lock send Esc alone and Ctrl in chords, which is what most Vim and Emacs people want, and [its keyboard settings](https://docs.blink.sh/basics/customize) cover the rest. Termius maps Ctrl, Alt, Esc, Tab, arrows, and F1 to F10 from a hardware keyboard and hides its on-screen bar when one is attached. Whatever you pick, set it up before anything else; the keyboard is why the iPad beats the phone.",
          },
          {
            title: "Arrange the screen",
            body: "Stage Manager gives you overlapping, resizable windows — a terminal beside a browser beside your notes — and Split View still works for two apps side by side; Blink supports Split View directly. On an M-series iPad, Stage Manager extends to an [external display](https://support.apple.com/en-us/105075) as a second screen rather than a mirror, which is where the setup stops feeling like a tablet, and Blink will drive that display at 4K.",
          },
          {
            title: "Make it survive the lid",
            body: "The keyboard case closes and the connection is gone. Run tmux on the host and start every job inside it, and connect with mosh so that closing the case, changing network, or moving from the café to the train is a hiccup instead of a loss. mosh needs UDP 60000–61000 open beside port 22, and it syncs only the visible screen, so tmux underneath is not optional.",
            code: {
              caption: "Each time, from the iPad",
              lines: ["mosh user@host", "tmux attach -t work || tmux new -s work"],
            },
          },
        ],
      },
      {
        kind: "points",
        heading: "What the iPad still is.",
        lead: "Even set up well, the arrangement has edges, and they are the same edges wherever SSH is the plumbing.",
        items: [
          {
            title: "A window, not a workstation",
            body: "Everything runs on the host. When the host is a laptop that sleeps, the iPad is a window onto nothing. The setup is only as good as the machine at the other end being awake, reachable, and left in tmux.",
          },
          {
            title: "Keys and hosts, multiplied",
            body: "The iPad is your second or third device. Each one carries a key; each host carries each key; losing one device means visiting every host.",
          },
          {
            title: "The tailnet tax",
            body: "Reaching home from anywhere means a VPN agent on every host and every device, and a vendor account in the middle. Fine for one person; tedious for three machines and two tablets.",
          },
          {
            title: "Arriving cold",
            body: "You reattach to a prompt and reconstruct where you were. For long-running agents that ask questions while you are away, that reconstruction is the job.",
          },
        ],
      },
      {
        kind: "prose",
        heading: "Or skip SSH entirely.",
        paragraphs: [
          "For machines you own, there is a shape that keeps everything the iPad is good at and drops the plumbing. spawnd puts one daemon on each host; it dials out, so nothing on the host listens — no forwarded port, no VPN, no key on the iPad. The iPad’s browser is the console, installable to the home screen, approved once against a short code; if the iPad goes, revoking it is one click that every host honors.",
          "Sessions live on the host — a worker process owns each one’s PTY — so closing the keyboard case, losing the café Wi‑Fi, or restarting the daemon costs nothing, and the scrollback is intact when you come back. What you come back to is a workspace per project with a grid of sessions across hosts, an attention cue on the one where an agent is waiting on a yes, and a notification when it happened. Your browser talks to each daemon peer-to-peer, end-to-end encrypted; the server that introduces them never sees session content. It is open source, MIT/Apache-2.0. For the case for keeping an SSH client beside it, [Termius alternatives](/termius-alternatives) ranks eight of them honestly, with the client-free route alongside.",
        ],
      },
    ],
    start: "One line on the host; the iPad brings a browser.",
    faq: [
      {
        q: "Can you really do software development on an iPad?",
        a: "Yes, as a terminal to a real machine. iPadOS won’t run your toolchain, so every serious setup is an SSH client or a browser console on the iPad and a Mac or Linux box doing the work. With a hardware keyboard and an external display it is a genuinely good arrangement.",
      },
      {
        q: "Which SSH client is best on iPad?",
        a: "Blink Shell if you live on a hardware keyboard — its remaps, mosh, and external-display support are the deepest. Termius if you want the same client on desktop and phone with hosts synced. Prompt 3 if you also use a Mac and want one licence.",
      },
      {
        q: "Does spawnd work on an iPad?",
        a: "Yes — the console is a web app, so Safari on the iPad is enough; install it to the home screen. Nothing runs on the iPad itself; the daemon runs on the macOS or Linux hosts you own.",
      },
    ],
    related: [
      {
        title: "Remote access to your Mac",
        blurb:
          "Every method compared: what each opens, what each costs, and which work from a phone.",
        href: "/remote-access-to-your-mac",
      },
      {
        title: "Termius alternatives",
        blurb: "Eight clients ranked honestly, and the route that needs no client at all.",
        href: "/termius-alternatives",
      },
      {
        title: "SSH from an iPhone",
        blurb: "the same route on the smaller screen",
        href: "/ssh-from-iphone",
      },
    ],
    cardTitle: "SSH on an iPad",
    cardBlurb:
      "Clients, keys, the hardware keyboard, Stage Manager — and the honest meaning of a dev machine.",
  },

  {
    slug: "ssh-from-android",
    kind: "guide",
    hub: { name: "Guides", href: "/guides" },
    title: "SSH from Android: Termux, ConnectBot, Termius, and the rest",
    description:
      "How to SSH from Android in 2026: which client still works, why Termux comes from F-Droid, keys, reaching the host, and stopping Android from killing the session.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "SSH from",
      accent: "Android",
      sub: "The client landscape has shifted, the battery manager is out to get you, and the phone can still be a real terminal. Here is the route that works.",
    },
    body: [
      {
        kind: "prose",
        heading: "The Android SSH landscape, September 2026.",
        paragraphs: [
          "The app most guides still recommend is gone. JuiceSSH’s Play Store listing returns a not-found page, and its own site refused connections when we checked; an app you can no longer install is not a recommendation. What is left is better than it sounds. ConnectBot, the original Android SSH client, is open source under Apache-2.0 and still shipping releases. Termius is the polished cross-platform option, free for the basics. And Termux is a real Linux userland on the phone — OpenSSH, mosh, tmux, git, all installed with a package manager — which makes it the power route and the one this guide leans on.",
          "Android is also honest about a thing iOS hides: it will kill your background process to save battery, and it will tell you so. Most of the Android-specific work is persuading it not to.",
        ],
      },
      {
        kind: "table",
        heading: "The clients.",
        lead: "Sources and prices from each project’s own pages, September 2026.",
        columns: ["Client", "Price", "Where to get it", "Keys", "Mosh"],
        rows: [
          [
            "Termux",
            "Free; open source",
            "F-Droid or GitHub releases — the Play build is a separate, experimental one",
            "`ssh-keygen`, as on Linux",
            "Yes — `pkg install mosh`",
          ],
          [
            "ConnectBot",
            "Free; Apache-2.0",
            "Play Store, F-Droid, GitHub releases",
            "Generated and stored in the app; public-key auth and port forwards built in",
            "No",
          ],
          [
            "Termius",
            "Starter free; Pro $10/month billed annually",
            "Play Store",
            "Generated in app; biometric keys in the Android Keystore on Pro",
            "Yes",
          ],
          ["JuiceSSH", "—", "Gone from the Play Store; the listing returns not found", "—", "—"],
        ],
      },
      {
        kind: "steps",
        heading: "The route, with Termux.",
        steps: [
          {
            title: "Install Termux from F-Droid, not the Play Store",
            body: "Get the APK from [F-Droid](https://f-droid.org/en/packages/com.termux/) or the project’s [GitHub releases](https://github.com/termux/termux-app). The Play Store build is a separate experimental one for Android 11 and later with missing functionality, and because the builds are signed with different keys, switching sources later means a full uninstall. Pick one and stay. Then bring the package lists up to date.",
            code: { lines: ["pkg upgrade"] },
          },
          {
            title: "Install OpenSSH and make a key",
            body: "Termux’s `pkg` is a front end over apt. Install OpenSSH, tmux, and mosh in one go, generate an Ed25519 key, and append the public half to `~/.ssh/authorized_keys` on the host. If you would rather not touch a shell for this, ConnectBot generates and stores keys in the app, and Termius does it under Keychain → New key, with a biometric key in the Android Keystore on its Pro plan.",
            code: {
              lines: [
                "pkg install openssh tmux mosh",
                "ssh-keygen -t ed25519",
                "cat ~/.ssh/id_ed25519.pub",
              ],
            },
          },
          {
            title: "Reach the host",
            body: "On the same Wi‑Fi, `ssh user@192.168.1.20` works as it would from a laptop. From anywhere else, put the phone and the host on a tailnet: [Tailscale for Android](https://tailscale.com/docs/install/android) is on the Play Store and the personal plan is free, and [Tailscale SSH](https://tailscale.com/kb/1193/tailscale-ssh) can replace the key step for Linux and macOS hosts. A port forward to 22 on the router is the fallback, and it puts sshd on the public internet, so if you take it, disable password login.",
          },
          {
            title: "Keep the session with tmux, and the channel with mosh",
            body: "tmux keeps the shell alive on the host when the phone disappears; mosh keeps the connection alive while the phone roams from Wi‑Fi to cellular and back. mosh needs UDP 60000–61000 open beside port 22 and syncs only the visible screen, which is why [mosh.org](https://mosh.org/) tells you to run tmux underneath. Start every job inside tmux, without exception.",
            code: {
              caption: "Each time, from the phone",
              lines: ["mosh user@host", "tmux attach -t work || tmux new -s work"],
            },
          },
          {
            title: "Stop Android from killing it",
            body: "Android will end a background Termux the moment the battery manager decides to, and vendors differ wildly — [dontkillmyapp.com](https://dontkillmyapp.com/) ranks them, and stock Android is the gentlest. Two settings help: tap Acquire wakelock in Termux’s persistent notification so the CPU stays awake while a job runs, and set Termux’s battery usage to Unrestricted in Android’s app settings. Then don’t rely on either. With tmux on the host, a killed app costs a reconnect, not the work.",
          },
          {
            title: "Hardware keyboards and DeX",
            body: "Termux’s extra-keys row — Esc, Tab, Ctrl, Alt, and arrows by default, configurable in `~/.termux/termux.properties` and reloaded with `termux-reload-settings` — is what makes the on-screen keyboard bearable; Termius hides its own bar automatically when a hardware keyboard connects. On a Samsung phone, [DeX](https://www.samsung.com/us/apps/dex/) turns a monitor or TV, wired or wireless, into a desktop with windowed apps: a terminal beside a browser is a legitimate working setup, and the phone is still the phone.",
            code: {
              caption: "~/.termux/termux.properties — the default row",
              lines: ["extra-keys = [[ESC, TAB, CTRL, ALT, {key: '-', popup: '|'}, DOWN, UP]]"],
            },
          },
        ],
      },
      {
        kind: "points",
        heading: "The Android-specific pain, named.",
        items: [
          {
            title: "The battery manager",
            body: "Every vendor tunes it differently, and the settings move between Android versions. A session that survived on a Pixel dies on a Samsung. The only reliable defence is a session that doesn’t live on the phone at all.",
          },
          {
            title: "Two Termuxes",
            body: "The F-Droid and Play builds are different apps with different signing keys. Install from one, forever, or reinstall from scratch.",
          },
          {
            title: "Keys on a phone",
            body: "A key on the device goes wherever the device goes. Biometric keys in the Keystore help; the authorized_keys entry on every host that still needs removing does not.",
          },
          {
            title: "The same tmux discipline",
            body: "Nothing persists that you didn’t start inside tmux. On a phone, where the connection is most fragile, forgetting once costs the most.",
          },
        ],
      },
      {
        kind: "prose",
        heading: "Or skip SSH entirely.",
        paragraphs: [
          "For servers you don’t control, the route above is the way in, and Termux is a fine way to walk it. For machines that are yours there is a shape with no client on the phone at all. spawnd installs one daemon on each host you own; the daemon dials out, so nothing on the host listens — no forwarded port, no VPN. On the phone, Chrome installs the console to the home screen as a web app; nothing else installs, no key lives on the phone, and the device is approved once against a short code. Revoking it is one click that every host honors.",
          "The battery manager stops mattering, because the session was never on the phone. Each one is owned by a worker process on the host, so it survives the closed tab, the dropped connection, and a daemon restart, scrollback intact, with no tmux to remember. What the phone opens onto is one workspace per project, a grid of sessions across hosts, an attention cue when an agent is waiting on a yes, and a notification so you don’t have to keep checking. Your browser talks to each daemon peer-to-peer, end-to-end encrypted; the server that introduces them never sees session content. It is open source, MIT/Apache-2.0. The iOS half of this route is [SSH from an iPhone](/ssh-from-iphone), and [Termius alternatives](/termius-alternatives) ranks the clients beside the route that needs none.",
        ],
      },
    ],
    start: "One line on the host, nothing on the phone.",
    faq: [
      {
        q: "Is JuiceSSH still available?",
        a: "Not from the Play Store — its listing now returns a not-found page. ConnectBot (free, open source) and Termius (free tier) are the direct replacements, and Termux is the power route.",
      },
      {
        q: "Should I install Termux from Google Play or F-Droid?",
        a: "F-Droid or the GitHub releases. The Play build is a separate experimental version with missing functionality, and it is signed with a different key, so you cannot switch between the two without uninstalling.",
      },
      {
        q: "Why does Android keep killing my SSH session?",
        a: "Battery optimisation, and some vendors are aggressive about it. Acquire Termux’s wakelock, set its battery usage to unrestricted, and run tmux on the host so a kill costs a reconnect rather than the job. Or use a console where the session never lived on the phone.",
      },
    ],
    related: [
      {
        title: "Claude Code, remote",
        blurb: "Remote Control, the web, and SSH + tmux — then the machines they leave out.",
        href: "/claude-code-remote",
      },
      {
        title: "Termius alternatives",
        blurb: "Eight clients ranked honestly, and the route that needs no client at all.",
        href: "/termius-alternatives",
      },
      {
        title: "SSH from an iPhone",
        blurb: "the same route on the other platform",
        href: "/ssh-from-iphone",
      },
    ],
    cardTitle: "SSH from Android",
    cardBlurb:
      "Termux from F-Droid, ConnectBot, Termius, the battery manager — and the route with nothing on the phone.",
  },

  {
    slug: "best-ssh-client-for-windows",
    kind: "roundup",
    hub: { name: "Guides", href: "/guides" },
    title: "Best SSH client for Windows: an honest roundup",
    description:
      "Windows SSH clients compared on price, SFTP, key agent, tabs, and mosh: built-in OpenSSH, PuTTY, Termius, MobaXterm, Tabby, Bitvise, WSL — and when a browser wins.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "The best SSH client for",
      accent: "Windows",
      sub: "Eight honest options, one table, and who each is for — starting with the one you already have.",
    },
    body: [
      {
        kind: "prose",
        heading: "Start with what Windows already ships.",
        paragraphs: [
          "Windows has had a real OpenSSH client since Windows 10 build 1809, as a [feature on demand](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-overview). Open PowerShell and type `ssh -V`; if it answers, you are done installing. If not, add it from Settings → Optional features, or from an administrator PowerShell with the first line below. It is the same `ssh`, `scp`, `sftp`, `ssh-keygen`, and `ssh-agent` you would use on a Mac, and [Windows Terminal](https://learn.microsoft.com/en-us/windows/terminal/install) — the default terminal on Windows 11 since 22H2, a Store install on Windows 10 — gives it tabs, split panes, and profiles that pick up WSL distributions automatically.",
          "That combination is the right answer for most people, and it is free. The one thing to know is the agent: Windows ships `ssh-agent` as a service that is disabled by default. Enable it once, `ssh-add` your key, and every terminal you open can use it without a passphrase prompt. Microsoft’s [key management page](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement) has the rest; `ssh-keygen` defaults to Ed25519.",
        ],
        code: {
          caption: "Administrator PowerShell",
          lines: [
            "Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0",
            "Get-Service ssh-agent | Set-Service -StartupType Automatic",
            "Start-Service ssh-agent",
            "ssh-keygen -t ed25519",
            "ssh-add $env:USERPROFILE\\.ssh\\id_ed25519",
          ],
        },
      },
      {
        kind: "table",
        heading: "Side by side.",
        lead: "Facts from each vendor’s own site as of September 2026. mosh has no native Windows build, so that column is about who bundles a client.",
        columns: ["Client", "Price", "SFTP", "Key agent", "Tabs", "Mosh"],
        rows: [
          [
            "OpenSSH + Windows Terminal",
            "Free, built in",
            "`sftp` and `scp` on the command line",
            "`ssh-agent` as a Windows service",
            "Yes — tabs and split panes",
            "No",
          ],
          [
            "PuTTY",
            "Free, MIT",
            "PSFTP and PSCP, command line",
            "Pageant",
            "No — one window per session; several in one window is a long-standing wishlist item",
            "No",
          ],
          [
            "KiTTY",
            "Free; a fork of PuTTY 0.76",
            "pscp.exe and WinSCP integration",
            "As PuTTY",
            "As PuTTY, plus a session launcher and a sessions filter",
            "No",
          ],
          [
            "Termius",
            "Starter free; Pro $10/month billed annually; Team $20/seat",
            "Yes",
            "Own keychain; TPM-backed biometric keys",
            "Yes",
            "Yes — Mosh 1.3.0 and newer",
          ],
          [
            "MobaXterm",
            "Home free, capped at 12 sessions and 2 tunnels; Professional $69/user/year",
            "Graphical browser in the sidebar; edited files save back",
            "Not documented on the vendor site",
            "Yes — multitab, up to four terminals per view",
            "Yes — a Mosh session type",
          ],
          [
            "Tabby",
            "Free, MIT",
            "Yes",
            "Forwards Pageant or the Windows OpenSSH agent",
            "Yes — tabs on any side, nested split panes",
            "No",
          ],
          [
            "Bitvise SSH Client",
            "Free for any use; support licences from $39.95",
            "Graphical, with resume and recursive transfers",
            "Pageant; cannot use the Windows OpenSSH agent",
            "Not documented",
            "No",
          ],
          [
            "WSL (Ubuntu)",
            "Free; `wsl --install`",
            "Linux `sftp`, `rsync`, everything",
            "Linux `ssh-agent`",
            "Via Windows Terminal",
            "Yes — `apt-get install mosh`",
          ],
        ],
      },
      {
        kind: "points",
        heading: "Who each one is for.",
        items: [
          {
            title: "OpenSSH + Windows Terminal — almost everyone",
            body: "If your needs are ssh, scp, keys, and a config file, this is the answer, and it is already installed. Learn `~/.ssh/config` and you will not miss a GUI.",
          },
          {
            title: "PuTTY and KiTTY — the serial port and the locked-down desktop",
            body: "A single .exe with no installer, serial and Telnet alongside SSH, and Pageant. PuTTY is still maintained under an MIT licence. KiTTY adds session filtering, automatic logon, and a launcher to a PuTTY 0.76 base. Neither has tabs; both run anywhere.",
          },
          {
            title: "Termius — one client on every device",
            body: "Hosts, keys, and snippets synced across Windows, Mac, Linux, iOS, and Android; mosh; TPM-backed keys. The free tier is genuinely usable; sync is what the $10 buys.",
          },
          {
            title: "MobaXterm — the sysadmin’s toolbox",
            body: "SSH with an SFTP sidebar, an X server, RDP, VNC, serial, and mosh in one window. Home Edition is free with limits a home user rarely hits; Professional is $69 a year.",
          },
          {
            title: "Tabby — the modern, hackable terminal",
            body: "Open source, MIT, split panes and tabs, an SSH manager with jump hosts and agent forwarding to either Pageant or the Windows agent. Heavier than the rest, by its own README’s admission.",
          },
          {
            title: "Bitvise — files first",
            body: "A strong graphical SFTP client, free for any use, with a terminal and SOCKS tunnelling beside it. Choose it for file transfer; choose something else for a daily terminal.",
          },
          {
            title: "WSL — the honest power route",
            body: "One command installs Ubuntu; from there it is Linux: OpenSSH, mosh, tmux, rsync, and every tool you would use on a server. Windows Terminal picks it up as a profile. If you are going to spend your day in ssh, spend it here.",
          },
        ],
      },
      {
        kind: "prose",
        heading: "When the answer is a browser.",
        paragraphs: [
          "There is a case none of these serve: a Windows machine you cannot change. The corporate laptop where installing software needs a ticket, the locked-down desktop where the firewall says no, the borrowed PC. What you want from it is not an SSH client at all — it is your own machines at home or in the office: the Linux box running a build, the Mac running an agent, the workstation with the checkout. Every client above needs those machines to be reachable, which means a port forward, a VPN, or a tailnet the locked-down box will not let you install.",
          "spawnd inverts it. One daemon on each macOS or Linux host you own; the daemon dials out, so nothing on the host listens — no open port, no VPN. Any browser is the console, so the Windows machine contributes a browser tab and nothing else: no client to install, no key on the device, one approval against a short code, and a one-click revocation every host honors when the laptop goes back. Sessions live on the host with a worker process owning each PTY, so they outlive the closed tab and the dropped connection, scrollback intact, in a workspace per project with a grid of sessions across hosts. Your browser talks to each daemon peer-to-peer, end-to-end encrypted; the server that introduces them never sees session content. It is open source, MIT/Apache-2.0. To be exact about the boundary: the daemon runs on macOS and Linux, and the Windows machine is the browser side.",
        ],
      },
    ],
    start: "One line on the hosts you own; Windows brings the browser.",
    faq: [
      {
        q: "What is the best free SSH client for Windows?",
        a: "The one Windows ships: OpenSSH with Windows Terminal. It is the same OpenSSH as on Linux and macOS, with tabs and panes. If you want a GUI for hosts and keys, Termius’ free tier and Tabby (open source) are the strongest free options.",
      },
      {
        q: "Is PuTTY still worth using in 2026?",
        a: "Yes, for what it is: a small, free, portable client with serial and Telnet support and Pageant, still maintained. For a daily terminal you will miss tabs and a modern config; for a jump box or a serial console it remains ideal.",
      },
      {
        q: "Can I use mosh from Windows?",
        a: "Not with a native Windows build; mosh.org points Windows users to Cygwin or a Chrome app. In practice the answers are MobaXterm’s Mosh session type, Termius, or WSL with apt-get install mosh.",
      },
    ],
    related: [
      {
        title: "tmux cheatsheet",
        blurb: "sessions, windows, panes, and the fixes — searchable, every command verified",
        href: "/tmux-cheatsheet",
      },
      {
        title: "Remote access to your Mac",
        blurb:
          "Every method compared: what each opens, what each costs, and which work from a phone.",
        href: "/remote-access-to-your-mac",
      },
      {
        title: "Termius alternatives",
        blurb: "the cross-platform contender and what to use instead",
        href: "/termius-alternatives",
      },
    ],
    cardTitle: "Best SSH client for Windows",
    cardBlurb:
      "Built-in OpenSSH, PuTTY, Termius, MobaXterm, Tabby, Bitvise, WSL — and when a browser is the answer.",
  },
];
