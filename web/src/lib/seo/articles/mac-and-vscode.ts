import type { ArticleEntry } from "../flat-types";

/*
 * The DIY flywheel (grimoire §iv): remote access to a Mac, Remote Login, VS Code Remote SSH.
 * Pure data on the article template; see definitions.ts for the exemplar.
 *
 * Facts checked 2026-09-03 against:
 *   https://support.apple.com/guide/mac-help/allow-a-remote-computer-to-access-your-mac-mchlp1066/mac
 *     (Remote Login: System Settings > General > Sharing; All users / Only these users;
 *      "Allow full disk access for remote users"; the ssh username@hostname line; macOS Tahoe 26)
 *   https://support.apple.com/guide/mac-help/turn-screen-sharing-on-or-off-mh11848/mac
 *     (Screen Sharing switch, VNC password option, cannot coexist with Remote Management)
 *   https://support.apple.com/guide/mac-help/allow-apple-remote-desktop-to-access-your-mac-mh11851/mac
 *     (Remote Management switch)
 *   https://support.apple.com/guide/mac-help/share-the-screen-of-another-mac-mh14066/mac
 *     (Screen Sharing app; hostname or Apple Account; High Performance on Apple silicon + Sonoma 14+;
 *      the guide says nothing about Apple Account connections crossing networks — not claimed)
 *   https://support.apple.com/guide/mac-help/change-firewall-settings-on-mac-mh11783/mac
 *     (Network > Firewall; "Block all incoming connections" prevents connections to all other
 *      sharing services; "Automatically allow built-in software")
 *   https://support.apple.com/guide/mac-help/set-sleep-and-wake-settings-mchle41a6ccd/mac
 *     (Wake for network access; Energy on desktops, Battery > Options on laptops)
 *   https://support.apple.com/en-us/103229  (port 22 = SSH/SFTP/scp; 5900 = Screen Sharing/ARD; 3283 = ARD)
 *   https://support.apple.com/en-us/124963  (Tahoe 26: FileVault can be unlocked over ssh after a restart)
 *   https://apps.apple.com/us/app/apple-remote-desktop/id409907375  ($79.99, v3.10, macOS 15.5+)
 *   https://ss64.com/mac/systemsetup.html  (-setremotelogin on|off, -getremotelogin, admin required)
 *   https://github.com/scriptingosx/ManageMacs/wiki/Secure-Shell-(SSH)-or-Remote-Login
 *     (com.apple.access_ssh group; dseditgroup; -disabled rename under All users)
 *   https://www.stigviewer.com/stigs/apple_macos_15_sequoia/2025-05-05/finding/V-268477
 *     (PasswordAuthentication and KbdInteractiveAuthentication both needed on macOS sshd)
 *   https://docs.github.com/en/authentication/troubleshooting-ssh/error-ssh-add-illegal-option----apple-use-keychain
 *     (ssh-add --apple-use-keychain on Monterey and later)
 *   https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse
 *     (OpenSSH Client as a Windows optional feature; Windows 10 1809+)
 *   https://9to5mac.com/2019/05/31/back-to-my-mac-discontinued/  (Back to My Mac switched off 1 July 2019)
 *   https://tailscale.com/kb/1193/tailscale-ssh  (tailscale set --ssh; server only on Linux and the
 *      open-source macOS tailscaled variant; ACLs required; port 22 only)
 *   https://tailscale.com/kb/1065/macos-variants  (three macOS builds; only tailscaled serves SSH)
 *   https://tailscale.com/pricing  (Personal plan "Free forever")
 *   https://api.github.com/repos/rustdesk/rustdesk  (AGPL-3.0)
 *   https://raw.githubusercontent.com/rustdesk/doc.rustdesk.com/master/content/client/mac/_index.en.md
 *     (macOS needs Accessibility + Screen Recording; Input Monitoring on newer macOS)
 *   https://support.google.com/chrome/answer/1649523  (CRD: Mac host, host installer + PIN, iOS/Android apps)
 *   https://jumpdesktop.com/pricing-plans.html  and  https://apps.apple.com/us/app/jump-desktop-rdp-vnc-fluid/id524141863
 *   https://apps.apple.com/us/app/jump-desktop-remote-desktop/id364876095
 *     (Mac $34.99, iOS $14.99, Jump Desktop Connect free, Fluid/VNC/RDP)
 *   https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh
 *     (Remote - SSH, ms-vscode-remote.remote-ssh, host list incl. macOS 10.14+ with Remote Login,
 *      Windows 10/Server 2016+ with the official OpenSSH Server)
 *   https://code.visualstudio.com/docs/remote/ssh  (commands, ~/.ssh/config example, 1 GB min / 2 GB
 *      + 2 cores recommended, code --remote ssh-remote+host, remote.SSH.remotePlatform)
 *   https://code.visualstudio.com/docs/remote/linux  (glibc >= 2.28, libstdc++ >= 3.4.25, kernel >= 4.18;
 *      Alpine/musl not supported over SSH; ARM extensions may ship x86-only native modules)
 *   https://code.visualstudio.com/docs/remote/troubleshooting  (Kill VS Code Server on Host,
 *      showLoginTerminal, useLocalServer, Windows ssh-agent Set-Service/Start-Service,
 *      ControlMaster on macOS/Linux, AllowTcpForwarding yes, Show Log, ~/.vscode-server)
 *   https://code.visualstudio.com/docs/remote/faq  (remote.SSH.localServerDownload; server runs as the
 *      signed-in user; VS Code manages its lifecycle)
 *   https://code.visualstudio.com/docs/terminal/advanced  (persistent sessions: reload = reconnect to the
 *      same process; restart = contents restored, process relaunched)
 *   https://github.com/microsoft/vscode-remote-release/issues/3846  and
 *   https://github.com/microsoft/vscode-remote-release/issues/11040  and
 *   https://learn.microsoft.com/en-us/answers/questions/5578441/vs-code-remote-ssh-stuck-at-checking-log-and-pid-f
 *     (the "failed to start" and "Downloading VS Code Server" families; ~/.vscode-server on NFS/CIFS)
 *   https://windowsreport.com/bad-owner-or-permissions-on-ssh-config/  (icacls fix on Windows)
 *
 * Not verified, so not stated: whether the Screen Sharing app's Apple Account connection works across
 * networks; whether ssh-copy-id ships with current macOS (the manual copy is shown beside it);
 * whether macOS sshd picks up sshd_config changes without a toggle (the guide says toggle to be sure);
 * how long a Remote - SSH server keeps terminal processes after a dropped connection (the docs
 * promise nothing, and the page says so).
 */

export const MAC_AND_VSCODE: ArticleEntry[] = [
  {
    slug: "remote-access-to-your-mac",
    kind: "guide",
    hub: { name: "Guides", href: "/guides" },
    title: "Remote access to your Mac: every method, compared",
    description:
      "Screen Sharing, Remote Login, Tailscale and the remote desktop apps, compared: what each one opens on the Mac, what it costs, and which of them work from a phone.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "Remote access to your Mac:",
      accent: "every method, compared",
      sub: "Nine ways to reach a Mac that is not in front of you — what each one opens on the machine, what it costs, which survive leaving the house, and which work from a phone.",
    },
    body: [
      {
        kind: "prose",
        heading: "Decide what you want back: a screen or a shell.",
        paragraphs: [
          "Every method here answers one of two questions: do you want the Mac’s screen, or a shell on it? Screen methods ship pixels — they need a desktop session to capture, spend bandwidth on every frame, and on a phone hand you a 27-inch display through a keyhole. Shell methods ship text: a few kilobytes a second, fine on hotel Wi-Fi, native to a Mac mini that has never had a monitor. Most people want the screen once a month and the shell every day.",
          "The second question is where you are. On the same Wi-Fi, every built-in method works with a switch in System Settings; from anywhere else a router stands in the way, and getting through it is its own section below.",
        ],
      },
      {
        kind: "table",
        heading: "The methods, side by side.",
        lead: "Checked against the vendors’ pages on 3 September 2026; ports from [Apple’s list](https://support.apple.com/en-us/103229).",
        columns: ["Method", "What you get", "What must be exposed", "From a phone?", "Cost"],
        rows: [
          [
            "Screen Sharing (built in)",
            "The full desktop, over VNC",
            "TCP 5900 on the Mac; LAN or VPN to reach it",
            "With a VNC app, cramped",
            "Free",
          ],
          [
            "Remote Login (built in)",
            "A shell, plus SFTP and scp",
            "TCP 22 on the Mac; LAN or VPN to reach it",
            "With an SSH app",
            "Free",
          ],
          [
            "Apple Remote Desktop",
            "Desktop control plus admin: software pushes, reports, remote commands",
            "Remote Management on each Mac (ports 3283 and 5900)",
            "No — the admin app is Mac-only",
            "$79.99 once",
          ],
          [
            "Messages screen sharing",
            "Another person’s desktop, once they accept",
            "Nothing to configure; both sides in Messages",
            "No — Mac to Mac",
            "Free",
          ],
          [
            "Tailscale + Remote Login or Screen Sharing",
            "The same shell or desktop, from anywhere",
            "Nothing on the router; Tailscale on every device",
            "Tailscale app plus an SSH or VNC app",
            "Free for personal use",
          ],
          [
            "Tailscale SSH",
            "SSH with the tailnet as the key",
            "Same; on macOS only the open-source `tailscaled` build can serve it",
            "The same pairing of apps",
            "Free for personal use",
          ],
          [
            "RustDesk",
            "Desktop, via a rendezvous server you can self-host",
            "Screen Recording and Accessibility permissions; their relay or yours",
            "Yes — iOS and Android apps",
            "Free, AGPL-3.0; the Pro server is paid",
          ],
          [
            "Chrome Remote Desktop",
            "Desktop, through Google",
            "A host installer and a Google account",
            "Yes — iOS and Android apps",
            "Free",
          ],
          [
            "Jump Desktop",
            "Desktop over Fluid, VNC, or RDP",
            "The free Jump Desktop Connect agent on the Mac",
            "Yes — iOS app",
            "$34.99 Mac, $14.99 iOS",
          ],
        ],
        note: "Per [Tailscale’s docs](https://tailscale.com/kb/1065/macos-variants), the App Store and standalone macOS builds are SSH clients on the tailnet, not servers; plain Remote Login over a tailnet address works with any build.",
      },
      {
        kind: "steps",
        heading: "Turn on the two built-in methods.",
        lead: "Both live in the same pane. Paths are macOS Tahoe 26; Ventura onward matches.",
        steps: [
          {
            title: "Open Sharing.",
            body: "Apple menu > System Settings, click General in the sidebar, then Sharing. Each service is a switch with an info button for its options, and the pane shows the Mac’s local hostname — the `.local` name other machines on the same network resolve.",
          },
          {
            title: "Screen Sharing: turn it on and choose who may connect.",
            body: "Click the info button next to Screen Sharing, turn it on, and choose All users or Only these users. “VNC viewers may control screen with password” lets non-Apple VNC clients in with a password instead of a Mac account. Remote Management — Apple Remote Desktop’s switch — and Screen Sharing cannot both be on; if Screen Sharing is greyed out, that is why ([Apple’s guide](https://support.apple.com/guide/mac-help/turn-screen-sharing-on-or-off-mh11848/mac)).",
          },
          {
            title: "Remote Login: turn it on and decide about full disk access.",
            body: "Click the info button next to Remote Login, turn it on, and choose the users again. “Allow full disk access for remote users” lets SSH sessions read the folders macOS otherwise protects; leave it off until a job needs it. From a terminal, the same switch needs an administrator.",
            code: {
              lines: ["sudo systemsetup -setremotelogin on", "sudo systemsetup -getremotelogin"],
            },
          },
          {
            title: "Connect to the screen.",
            body: "On another Mac, open the Screen Sharing app and pick the Mac under Network in the sidebar, or click the new-connection button and type a hostname or an Apple Account. On Apple silicon with Sonoma 14 or later you are offered Standard or High Performance; take High Performance on a good network ([Apple’s connection guide](https://support.apple.com/guide/mac-help/share-the-screen-of-another-mac-mh14066/mac)).",
          },
          {
            title: "Connect to the shell.",
            body: "From a Mac, a Linux box, or Windows 10 or 11 with Microsoft’s OpenSSH client, it is one line; accept the host key the first time. [Remote Login on a Mac](/mac-remote-login) covers keys, named users, and the errors.",
            code: { lines: ["ssh you@your-mac.local"] },
          },
          {
            title: "Keep the Mac reachable when it is idle.",
            body: "A sleeping Mac answers nobody. On a desktop, System Settings > Energy has “Wake for network access” and “Prevent automatic sleeping when the display is off”; on a laptop they sit under Battery > Options and apply only on the power adapter ([Apple’s sleep and wake guide](https://support.apple.com/guide/mac-help/set-sleep-and-wake-settings-mchle41a6ccd/mac)).",
          },
        ],
      },
      {
        kind: "prose",
        heading: "Leaving the house is the hard part.",
        paragraphs: [
          "Every built-in method assumes you can reach the Mac’s address, and on your own Wi-Fi you can. From a café, the Mac sits behind your router with a private address nobody outside can route to, and the router passes nothing in unless you tell it to. That is port forwarding: TCP 22 or 5900 from the router’s public side to the Mac, and from that moment your Mac is answering the whole internet. sshd with keys only is defensible there; VNC with a password is not.",
          "Two more problems come with forwarding. Home connections change public address, so you need dynamic DNS to find the router at all, and a growing share of ISPs use carrier-grade NAT, where there is no public address to forward from and no setting fixes it. Apple’s answer used to be Back to My Mac, which found your Mac through iCloud from anywhere; Apple [switched it off on 1 July 2019](https://9to5mac.com/2019/05/31/back-to-my-mac-discontinued/). Nothing in macOS has replaced it — the Screen Sharing app can address a Mac by Apple Account, but Apple’s guide says nothing about reaching one on another network, so do not plan a trip around it.",
          "The honest fixes come in two families. A private network — Tailscale is the best known — puts the Mac and your other devices on a WireGuard mesh that crosses NAT without forwarding, for the price of a client on every device. Or a service in the middle — RustDesk, Chrome Remote Desktop, Jump Desktop — has the Mac dial out to a rendezvous server that brokers the connection; the router never learns, and the service becomes a party to the arrangement, which RustDesk lets you fix by running the server yourself.",
        ],
      },
      {
        kind: "prose",
        heading: "For a Mac that runs things, the terminal is the honest route.",
        paragraphs: [
          "If the Mac is a mini under the desk running builds, a media server, or a coding agent through the night, you do not need its pixels, and shipping them to a phone is the heaviest way to move text. Remote Login gives you the shell for free, and with keys and a named user it is safe at home. What SSH does not give you is a session that survives you: background the SSH app on the phone and the shell, and whatever was running in it, is gone unless you started it inside tmux. And it still needs a path in — the forward, the VPN, the client on every device.",
          "spawnd is that route with the network problem and the persistence problem removed. One daemon runs on the Mac — it runs on macOS and Linux — and dials out, so nothing listens on the Mac, no port is forwarded, and no VPN is needed. Each session’s PTY is owned by a worker process on the Mac, so a session survives the closed tab, the dropped connection, the laptop lid, and a daemon restart, scrollback intact. Any browser is the console; on a phone it installs to the home screen as a web app — no client app, no keys on the device. A new device is approved once against a short code, and revoking it is one click every host honors. Your browser talks to each daemon peer-to-peer, end-to-end encrypted, and the server that introduces them never sees session content. It is open source, MIT/Apache-2.0.",
          "It is not screen sharing and does not pretend to be — for the monthly GUI job keep Screen Sharing or RustDesk beside it; [spawnd vs remote desktop](/spawnd-vs-remote-desktop) draws that line. For the daily shell the Mac stops needing a hole in the router; [spawnd vs Tailscale SSH](/spawnd-vs-tailscale-ssh) covers where the private-network route still wins.",
        ],
      },
      {
        kind: "capture",
        caption:
          "The terminal route without the router in the way: sessions from three machines in one browser grid, each one persistent on the host that owns it.",
      },
    ],
    start: "One line on the Mac, and it dials out.",
    faq: [
      {
        q: "Can I remote into my Mac from an iPhone?",
        a: "Yes. For the screen, RustDesk, Chrome Remote Desktop, and Jump Desktop all have iOS apps; for a shell, any SSH app reaches Remote Login. Away from home you still need a path in — a VPN such as Tailscale, a port forward, or a tool that relays for you. spawnd takes the shell route with no app and no port: the browser on the phone is the console.",
      },
      {
        q: "Does Back to My Mac still exist?",
        a: "No. Apple switched it off for every version of macOS on 1 July 2019. Its suggested replacements were iCloud Drive for files and Apple Remote Desktop or Screen Sharing for control, neither of which crosses a router on its own.",
      },
      {
        q: "What is the difference between Screen Sharing and Remote Management?",
        a: "Both serve the Mac’s screen over VNC on port 5900. Remote Management adds what Apple Remote Desktop needs — software distribution, reports, remote commands — and the two switches are mutually exclusive: turn one on and the other greys out.",
      },
    ],
    related: [
      {
        title: "Remote Login on a Mac",
        blurb: "the SSH switch in full: named users, keys, the firewall, and the errors",
        href: "/mac-remote-login",
      },
      {
        title: "spawnd vs remote desktop",
        blurb: "pixels versus text, and when each is the right unit",
        href: "/spawnd-vs-remote-desktop",
      },
      {
        title: "Remote access without open ports",
        blurb: "the outbound-only model, explained end to end",
        href: "/use/remote-access-without-open-ports",
      },
    ],
    cardTitle: "Remote access to your Mac",
    cardBlurb:
      "Every method compared: what each opens, what each costs, and which work from a phone.",
  },

  {
    slug: "mac-remote-login",
    kind: "guide",
    hub: { name: "Guides", href: "/guides" },
    title: "Remote Login on a Mac: turn on SSH and connect",
    description:
      "Remote Login is macOS’s SSH server. How to turn it on from Settings or a terminal, limit it to named users and keys, pass the firewall, and fix a refused connection.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "Remote Login on a Mac,",
      accent: "set up properly",
      sub: "What the switch actually starts, how to turn it on from Settings or a terminal, how to keep it to keys and named users, and what to do when the connection is refused.",
    },
    body: [
      {
        kind: "prose",
        heading: "What Remote Login is.",
        paragraphs: [
          "Remote Login is the Sharing switch that starts macOS’s SSH server. Turn it on and the Mac listens on TCP port 22 for SSH, and with it SFTP and scp, because they ride the same service — Apple’s [port list](https://support.apple.com/en-us/103229) files all three under 22. Anyone who can reach that port with a Mac account or a key you have authorized gets a shell as that user. The server is OpenSSH, the same one every Linux box runs, so everything you know about `ssh` applies.",
          "Two macOS-specific details. The switch has an “Allow full disk access for remote users” option, because macOS protects folders like Desktop and Documents from processes that have not been granted access, and an SSH session is one; leave it off until a job needs it. And since macOS Tahoe 26, a FileVault-encrypted Mac can be [unlocked over ssh after a restart](https://support.apple.com/en-us/124963) if Remote Login is on and the network is up — the first time a headless Mac with FileVault has been manageable from a distance.",
        ],
      },
      {
        kind: "steps",
        heading: "Turn it on.",
        lead: "The paths are macOS Tahoe 26; Ventura onward has the same pane.",
        steps: [
          {
            title: "Flip the switch.",
            body: "Apple menu > System Settings, General in the sidebar, then Sharing. Click the info button next to Remote Login and turn it on. The pane shows the line another machine uses to reach you, `ssh you@hostname`, with the Mac’s `.local` name filled in ([Apple’s guide](https://support.apple.com/guide/mac-help/allow-a-remote-computer-to-access-your-mac-mchlp1066/mac)).",
          },
          {
            title: "Or do it from a terminal.",
            body: "The same switch from a shell, for scripting a fresh Mac. `systemsetup` needs an administrator; the second line reports the state.",
            code: {
              lines: ["sudo systemsetup -setremotelogin on", "sudo systemsetup -getremotelogin"],
            },
          },
          {
            title: "Restrict who may log in.",
            body: "Under Allow access for, choose Only these users and add the accounts that need a shell. Behind the menu is a local group, `com.apple.access_ssh`: sshd admits its members and refuses everyone else. From a terminal the same restriction is a `dseditgroup` call; the [ManageMacs wiki](https://github.com/scriptingosx/ManageMacs/wiki/Secure-Shell-(SSH)-or-Remote-Login) documents the group and its “-disabled” rename under All users.",
            code: {
              lines: ["sudo dseditgroup -o edit -a you -t user com.apple.access_ssh"],
            },
          },
          {
            title: "Put a key on the Mac.",
            body: "On the machine you will connect from, make a key if you have none and put its public half in `~/.ssh/authorized_keys` on the Mac — `ssh-copy-id` where it exists, the manual form anywhere. Permissions matter to sshd: `~/.ssh` must be 700 and `authorized_keys` 600, or the key is silently ignored. On a Mac client, `ssh-add --apple-use-keychain` keeps the passphrase in the keychain.",
            code: {
              lines: [
                "ssh-keygen -t ed25519",
                "ssh-copy-id you@your-mac.local",
                "# or, without ssh-copy-id:",
                "cat ~/.ssh/id_ed25519.pub | ssh you@your-mac.local \\",
                "  'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'",
              ],
            },
          },
          {
            title: "Close the password door.",
            body: "Once the key works, turn passwords off in `/etc/ssh/sshd_config` on the Mac. macOS accepts passwords through keyboard-interactive as well as the plain method, so both lines are needed. Toggle Remote Login off and on afterwards, and test from a second terminal before closing the one you are in.",
            code: {
              caption: "/etc/ssh/sshd_config",
              lines: ["PasswordAuthentication no", "KbdInteractiveAuthentication no"],
            },
          },
          {
            title: "Check the firewall and the sleep settings.",
            body: "The firewall is under System Settings > Network > Firewall. With “Automatically allow built-in software to receive incoming connections” on — the default — sshd is admitted; with “Block all incoming connections” on, Apple’s [firewall guide](https://support.apple.com/guide/mac-help/change-firewall-settings-on-mac-mh11783/mac) says connections to all other sharing services are prevented, and Remote Login stops answering with its switch still on. Then make sure the Mac is awake to answer: “Wake for network access” under Energy on a desktop, or Battery > Options on a laptop, power adapter only.",
          },
        ],
      },
      {
        kind: "prose",
        heading: "Connect from a Mac, a PC, or a phone.",
        paragraphs: [
          "From another Mac or a Linux machine, it is the line the Sharing pane showed you: `ssh you@your-mac.local`. The `.local` name is resolved by Bonjour and works only on the same network; elsewhere use the address or a name you control. The first connection shows the Mac’s host key fingerprint and asks you to accept it; that is how your client recognises the Mac from then on.",
          "Windows 10 and 11 carry Microsoft’s OpenSSH client as an optional feature, usually already present — `ssh` works from PowerShell, and Microsoft’s [OpenSSH guide](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse) covers adding it. From a phone, any SSH app reaches Remote Login with the same account or key; [SSH from an iPhone](/ssh-from-iphone) covers the apps, and the honest summary is small type and a session that ends when the app is backgrounded.",
        ],
      },
      {
        kind: "prose",
        heading: "Reaching it from outside your network.",
        paragraphs: [
          "Remote Login makes the Mac listen; it does nothing to make it reachable. On your own Wi-Fi the two coincide; from anywhere else your router’s NAT stands in the way, and you have three honest options. Forward TCP 22 from the router to the Mac, which puts sshd on the public internet: fine with keys only and named users, reckless with passwords, dependent on dynamic DNS to find your changing home address, and impossible behind carrier-grade NAT, where you have no public address to forward from.",
          "Or put the Mac on a private network: Tailscale and its peers give the Mac and your other devices addresses that reach each other across NAT without forwarding, and Remote Login answers on the tailnet address as it does on the LAN, for the price of a client on every device. Or use something that never needs the Mac to listen at all — where this page turns, below.",
        ],
      },
      {
        kind: "points",
        heading: "When it fails.",
        lead: "Each of these is the text `ssh` prints, and each has a short list of causes.",
        items: [
          {
            title: "Connection refused",
            body: "Nothing is listening where you knocked. Remote Login is off, the firewall is set to block all incoming connections, or you reached a different machine. Check `sudo systemsetup -getremotelogin` on the Mac and the firewall pane; if both are right, confirm the name resolves to the Mac you think it does.",
          },
          {
            title: "Connection timed out",
            body: "The packets never arrived. Usually you are off the LAN and nothing forwards port 22, or a `.local` name is being used across networks where Bonjour cannot resolve it. On the LAN, a sleeping Mac produces the same symptom — see the wake settings above.",
          },
          {
            title: "Permission denied (publickey,password,keyboard-interactive)",
            body: "The Mac answered and turned you away. The account is not in Only these users, the public key is not in that user’s `authorized_keys`, or the permissions on `~/.ssh` are too open and sshd is ignoring the file. `ssh -v` shows which keys the client offered and which the server declined.",
          },
          {
            title: "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!",
            body: "The Mac’s host key no longer matches the one your client saved. After a clean reinstall, or a new Mac inheriting the old name, that is expected: `ssh-keygen -R your-mac.local` forgets the old key. If nothing on the Mac changed, stop and find out why before you accept a new one.",
          },
          {
            title: "Operation not permitted, on a folder you own",
            body: "The session logs in but cannot read Desktop, Documents, or another protected folder: that is the full disk access switch in the Remote Login options, off by design. Turn it on for the job and off afterwards.",
          },
        ],
      },
      {
        kind: "prose",
        heading: "Remote Login opens a listener. There is another shape.",
        paragraphs: [
          "Everything above is the right way to run SSH on a Mac, and at home with keys and a named user it is a good way to live. Its two limits are structural. The Mac must listen, so reaching it from outside means a forward or a VPN and a client on every device. And a session belongs to the connection: close the laptop, lose the train’s Wi-Fi, background the app on the phone, and the shell — with the build or the agent in it — is gone unless you remembered tmux.",
          "spawnd inverts both. One daemon runs on the Mac and dials out; nothing listens on the host, no port is forwarded, no VPN is needed. A worker process on the Mac owns each session’s PTY, so a session survives the closed tab, the dropped connection, the laptop lid, and a daemon restart, scrollback intact. Any browser is the console, and on a phone it installs to the home screen as a web app — no client app, no keys on the device; a new device is approved once against a short code, and revoking it is one click every host honors. Your browser talks to each daemon peer-to-peer, end-to-end encrypted, and the server that introduces them never sees session content. Remote Login can stay on beside it for scp and the tools that expect a port, or go off; [spawnd vs SSH + tmux](/spawnd-vs-ssh-and-tmux) lays the two side by side, and [remote access without open ports](/use/remote-access-without-open-ports) explains the outbound-only model.",
        ],
      },
      {
        kind: "capture",
        caption:
          "The shell on the Mac without the Mac listening: sessions from three machines in one browser grid, each persistent on the host that owns it.",
      },
    ],
    start: "One line on the Mac. No port 22.",
    faq: [
      {
        q: "Is it safe to leave Remote Login on?",
        a: "On a home network with key-only authentication and Only these users, yes; sshd is the most scrutinised listener there is. The risk is forwarding port 22 to the internet with passwords still enabled, where automated guessing starts within minutes.",
      },
      {
        q: "Does Remote Login let me copy files to and from the Mac?",
        a: "Yes. SFTP and scp use the same service and the same port, so any SFTP client or `scp` works with the login you already have. The full disk access switch decides whether protected folders are readable.",
      },
      {
        q: "Can I SSH into the Mac before anyone logs in after a restart?",
        a: "Since macOS Tahoe 26, yes: with Remote Login on and a network connection, a FileVault-encrypted Mac accepts an ssh login after a restart so an administrator can unlock the disk and let the boot finish. Earlier versions needed someone at the keyboard.",
      },
    ],
    related: [
      {
        title: "Remote access to your Mac",
        blurb: "every method compared, screen and shell",
        href: "/remote-access-to-your-mac",
      },
      {
        title: "spawnd vs SSH + tmux",
        blurb: "the classic, versus persistence and reach without a listener",
        href: "/spawnd-vs-ssh-and-tmux",
      },
      {
        title: "Remote access without open ports",
        blurb: "the outbound-only model, in full",
        href: "/use/remote-access-without-open-ports",
      },
    ],
    cardTitle: "Remote Login on a Mac",
    cardBlurb:
      "macOS’s SSH switch: turning it on, keys and named users, the firewall, and the errors.",
  },

  {
    slug: "vscode-remote-ssh",
    kind: "guide",
    hub: { name: "Guides", href: "/guides" },
    title: "VS Code Remote SSH: setup and the errors that stop it",
    description:
      "Set up VS Code’s Remote - SSH extension — host requirements, the config entry, keys and agents — then fix the connection failures and server hangs that follow.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "VS Code Remote SSH,",
      accent: "set up and unstuck",
      sub: "The extension, the hosts it accepts, the config entry that makes connecting one click, the errors it throws, and the one limit no setting fixes.",
    },
    body: [
      {
        kind: "prose",
        heading: "What the extension actually does.",
        paragraphs: [
          "Remote - SSH — `ms-vscode-remote.remote-ssh`, from Microsoft, also in the Remote Development pack — opens an SSH connection to a machine, installs a small VS Code Server into `~/.vscode-server` there, and from then on runs everything that touches files on that machine: the file tree, language servers, the debugger, extensions that need the code, and every integrated terminal. Your local VS Code becomes a window onto it. The server runs as the user you signed in as; VS Code installs and updates it to match the client’s version.",
          "Locally: an OpenSSH-compatible `ssh` on the PATH — macOS and Linux have one, Windows 10 and 11 carry Microsoft’s as an optional feature. The host must be one the server runs on: 64-bit x86 Linux with glibc 2.28+, libstdc++ 3.4.25+ and kernel 4.18+ — Ubuntu 20.04+, Debian 10+, RHEL 8+, per the [Linux prerequisites](https://code.visualstudio.com/docs/remote/linux); ARM64 and 32-bit ARMv7 Linux, where some extensions ship x86-only native code; macOS 10.14+ with Remote Login on; or Windows 10 and Server 2016+ with the official OpenSSH Server. Alpine and other musl-based hosts are not supported over SSH. Microsoft recommends 2 GB of RAM and two cores; 1 GB is the floor.",
        ],
      },
      {
        kind: "steps",
        heading: "Set it up.",
        lead: "The order matters: prove SSH in a terminal first, and the extension has nothing left to debug.",
        steps: [
          {
            title: "Make ssh work on its own.",
            body: "Connect from a terminal first. If this fails, the extension fails the same way with a less useful message.",
            code: { lines: ["ssh you@build-box"] },
          },
          {
            title: "Install the extension.",
            body: "Search Extensions for Remote - SSH, or install the Remote Development pack, which bundles it with Dev Containers, WSL, and Remote - Tunnels.",
          },
          {
            title: "Give the host a name in ~/.ssh/config.",
            body: "Run Remote-SSH: Add New SSH Host… from the Command Palette, or Remote-SSH: Open SSH Configuration File… and write the entry yourself. Everything `ssh` understands is allowed, including a jump host with `ProxyJump` and port forwards that follow the connection.",
            code: {
              caption: "~/.ssh/config",
              lines: [
                "Host build-box",
                "    HostName 10.0.0.12",
                "    User you",
                "    IdentityFile ~/.ssh/id_ed25519",
                "    LocalForward 127.0.0.1:3000 127.0.0.1:3000",
                "",
                "Host lab",
                "    HostName lab.internal",
                "    User you",
                "    ProxyJump bastion",
              ],
            },
          },
          {
            title: "Use a key, and an agent.",
            body: "Passwords work, but VS Code does not save them and may open more than one SSH connection, so you will type it repeatedly. Make an Ed25519 key, put the public half in the host’s `~/.ssh/authorized_keys`, and let an agent hold the passphrase — `ssh-add` on macOS and Linux; on Windows the OpenSSH agent service is disabled by default and needs enabling once from an administrator PowerShell.",
            code: {
              lines: [
                "ssh-keygen -t ed25519",
                "ssh-add ~/.ssh/id_ed25519",
                "# Windows, administrator PowerShell:",
                "Set-Service ssh-agent -StartupType Automatic",
                "Start-Service ssh-agent",
              ],
            },
          },
          {
            title: "Connect and open a folder.",
            body: "Remote-SSH: Connect to Host…, pick the entry, confirm the platform if asked, and wait for the server to install — a one-time download per VS Code version. Then File > Open Folder browses the remote filesystem; from a shell, the same thing is one command.",
            code: { lines: ["code --remote ssh-remote+build-box /home/you/project"] },
          },
          {
            title: "Cut the repeated prompts on macOS and Linux.",
            body: "Let OpenSSH multiplex and VS Code’s extra connections ride the first one, so a password or hardware-key touch is asked once. The docs offer this for macOS and Linux only; on Windows the agent is the fix.",
            code: {
              caption: "~/.ssh/config",
              lines: [
                "Host build-box",
                "    ControlMaster auto",
                "    ControlPath ~/.ssh/cm-%r@%h:%p",
                "    ControlPersist 10m",
              ],
            },
          },
        ],
      },
      {
        kind: "points",
        heading: "The errors, and what fixes them.",
        lead: "Start with Remote-SSH: Show Log; the last twenty lines usually name the cause. These come up most, checked against the [VS Code troubleshooting guide](https://code.visualstudio.com/docs/remote/troubleshooting) and the extension’s issue tracker.",
        items: [
          {
            title: "Could not establish connection to “host”: The VS Code Server failed to start",
            body: "The SSH connection worked and the server did not. Run Remote-SSH: Kill VS Code Server on Host and reconnect; a half-installed server is the usual cause. If it repeats, check the glibc and libstdc++ floor above (`ldd --version`), that the home directory has space, and — common on shared machines — that `~/.vscode-server` is not on an NFS or CIFS mount, where file locking hangs. Deleting `~/.vscode-server` on the host is the clean reset.",
          },
          {
            title:
              "Stuck on “Downloading VS Code Server”, or “Checking .log and .pid for a running server”",
            body: "The host cannot reach Microsoft’s download servers, or the install is waiting on a prompt you cannot see. Set `remote.SSH.localServerDownload` to `always` so VS Code downloads the server locally and copies it over SSH — the route for locked-down hosts with no outbound internet. If the host has internet and still hangs, turn on `remote.SSH.showLoginTerminal` to reveal a password or MFA prompt the extension swallowed, and set `remote.SSH.useLocalServer` to false if it still never surfaces.",
          },
          {
            title: "Permission denied (publickey), or a password prompt on every reconnect",
            body: "Your key is not offered or not accepted. `ssh -v you@host` shows which keys were tried; make sure the agent is running and holds the key, and that the entry names the right `IdentityFile`. On a hardened host, `AllowTcpForwarding yes` must be set in `sshd_config` — the extension needs a forwarded port to reach the server, and a host that forbids forwarding fails in confusing ways.",
          },
          {
            title: "Bad owner or permissions on C:\\Users\\you\\.ssh\\config",
            body: 'Windows only. OpenSSH refuses a config file whose permissions include inherited entries. From PowerShell, strip the inheritance and grant only your own account: `icacls $env:USERPROFILE\\.ssh /inheritance:r /grant:r "$($env:USERNAME):(F)" /t`. Do not edit the file from an administrator window afterwards; that hands ownership to the wrong account.',
          },
          {
            title: "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!",
            body: "The host’s key no longer matches `~/.ssh/known_hosts`. After a rebuild of the machine, `ssh-keygen -R hostname` forgets the old key and the next connection asks you to accept the new one. If the machine was not rebuilt, do not accept it until you know why.",
          },
          {
            title: "It connected yesterday and not today",
            body: "VS Code updated itself, and the server on the host must match the new build. Usually that happens silently; when it does not, Kill VS Code Server on Host and reconnect installs the matching one.",
          },
        ],
      },
      {
        kind: "prose",
        heading: "The connection is the workspace.",
        paragraphs: [
          "One limit is worth understanding before you rely on the setup, because no setting removes it. Every integrated terminal in a Remote - SSH window is a process on the host, started by the VS Code Server for your window. VS Code’s persistent sessions cover two cases, and the [terminal docs](https://code.visualstudio.com/docs/terminal/advanced) are exact: reload the window and the terminal reconnects to the same process; restart VS Code and its contents are restored but the process is relaunched. Relaunched, not resumed — the test run or the agent that was halfway through is not the one you get back.",
          "Close the laptop for the afternoon and you are in the second case, or a third the docs promise nothing about: the connection drops, the window reconnects when it can, and what survived depends on the host’s sshd timeouts and how long the server waited. Anything that must keep running while you are not connected belongs in tmux, nohup, or a service on the host — not in the editor’s terminal. The phone does not help: vscode.dev is an editor, not a terminal. If you cannot open a port on the machine, Microsoft’s Remote Tunnels reach it through their service instead of SSH, with the same terminal limit — [spawnd vs VS Code Remote Tunnels](/spawnd-vs-vscode-remote-tunnels) covers that trade.",
        ],
      },
      {
        kind: "prose",
        heading: "Sessions that survive the lid.",
        paragraphs: [
          "The editor part of Remote - SSH is excellent and nothing here argues with it. The terminal part is where the shape runs out, exactly where agent work begins: a Claude Code refactor that takes an hour, a test loop, a build that finishes at 2am — jobs that must survive you leaving and want answering from wherever you are.",
          "That is the job spawnd is shaped for, and it splits cleanly from the editor. One daemon on each host you own, dialing out — nothing listens on the host, no open ports, no VPN needed. A worker process on the host owns each session’s PTY, so a session survives the closed tab, the dropped connection, the laptop lid, and a daemon restart, scrollback intact. Any browser is the console, and on a phone it installs to the home screen as a web app; a new device is approved once against a short code. Your browser talks to each daemon peer-to-peer, end-to-end encrypted, and the server that introduces them never sees session content. Built-in shortcuts start Claude Code, Codex, OpenCode, or Aider in a real shell on the host, authenticated there as always; the workspace grid shows every session across every host, with an attention cue when an agent waits on a yes. Keep Remote - SSH for the editing; [keep agents running](/use/keep-agents-running) covers the persistence side.",
        ],
      },
      {
        kind: "capture",
        caption:
          "What the integrated terminal cannot be: agent sessions from three machines in one grid, each one alive on its host whether or not a laptop is open.",
      },
    ],
    start: "Edit in VS Code. Run the long things somewhere that stays up.",
    faq: [
      {
        q: "Does Remote - SSH work with a Mac as the remote?",
        a: "Yes. The extension supports macOS 10.14 and newer as a host, provided Remote Login is on in System Settings > General > Sharing. The same key and config entry you use for a Linux host apply.",
      },
      {
        q: "Can I use Remote - SSH without opening a port on the host?",
        a: "SSH needs a path to port 22: the same network, a VPN such as Tailscale, or a jump host via `ProxyJump`. Microsoft’s Remote Tunnels is the no-port alternative from the same team, routed through Microsoft’s service. For terminals alone, spawnd’s daemon dials out and needs neither.",
      },
      {
        q: "Do my terminals keep running when I disconnect?",
        a: "Not reliably. A window reload reconnects to the same process; a VS Code restart relaunches it; a dropped connection is promised nothing. Long jobs go in tmux or a service on the host, or in a spawnd session, which a worker on the host owns by construction.",
      },
    ],
    related: [
      {
        title: "spawnd vs VS Code Remote Tunnels",
        blurb: "editor remoting versus terminal possession",
        href: "/spawnd-vs-vscode-remote-tunnels",
      },
      {
        title: "Keep agents running",
        blurb: "sessions that survive the laptop, the tab, and the daemon",
        href: "/use/keep-agents-running",
      },
      {
        title: "Remote Login on a Mac",
        blurb: "the SSH server a Mac host needs, set up properly",
        href: "/mac-remote-login",
      },
    ],
    cardTitle: "VS Code Remote SSH",
    cardBlurb:
      "Setup, the config entry, the errors that stop it, and the one limit no setting fixes.",
  },
];
