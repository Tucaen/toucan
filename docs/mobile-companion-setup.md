# Set up the Toucan mobile companion

End-to-end setup for driving your Toucan desktops from an Android phone: turn on the remote
server, make each PC reachable over your own tailnet, put HTTPS in front of it so the app
installs to the home screen, and pair the phone with every PC you want to reach.

Follow it once per PC. Everything except the last section is a per-host step.

## What you end up with

- An icon on your phone's home screen that opens Toucan standalone, with no browser chrome.
- A host switcher listing every PC you paired, each with its own token and its own chats.
- Live transcripts, sending messages, answering tool permissions and questions, and starting
  new chats — all against whichever host is selected.

Toucan holds no cloud component and no relay. The phone talks straight to each PC.

## Before you start

- The desktop app must be **running** on each PC you want to reach. The remote server lives in
  Toucan's main process and serves the canvas that desktop has open; a closed Toucan is an
  offline host.
- The phone client is built as static assets Toucan serves itself. `npm run build` and
  `npm run package:win` include it; if you run from `npm run dev`, build it once by hand:

  ```powershell
  npm run build:mobile
  ```

  A host that never built it answers `503` with exactly that instruction.

## 1. Turn on the remote server

On the PC, open the phone icon in Toucan's header, enable remote access, and note the **port**
and the **pairing token**. The dialog also lists the addresses this PC can be reached at and
labels the tailnet one.

The listener binds all interfaces on purpose: narrowing the bind would break the tailnet
address that makes this useful. Nothing is reachable until the next step puts the PC on a
tailnet with your phone, and nothing is *authorized* without the token.

## 2. Join both devices to one tailnet

Reachability is deliberately not Toucan's problem. Install [Tailscale](https://tailscale.com)
on the PC and on the phone and sign both into the same tailnet.

Check it before going further: on the phone's browser, open
`http://<pc-tailnet-name>:<port>`. You should get the pairing screen. If you do, the network
half is done and everything after this is about HTTPS and pairing.

## 3. Put HTTPS in front of Toucan with `tailscale serve`

Toucan speaks plain HTTP and owns no certificates — TLS is Tailscale's job. This step is what
makes the app **installable**: service workers and installability require a secure context,
and a plain-HTTP tailnet address is not one.

Enable **HTTPS certificates** for your tailnet once, in the Tailscale admin console under DNS.
Without it `tailscale serve` has no certificate to issue and says so.

Then, on the PC, in a terminal:

```powershell
tailscale serve --bg --https=443 localhost:<port>
```

That fronts `http://localhost:<port>` with a valid `*.ts.net` certificate. Check what it
published, and the HTTPS URL to use:

```powershell
tailscale serve status
```

You get a URL shaped like `https://<pc-name>.<tailnet>.ts.net/`. Use that from now on; it is
the origin the phone installs from.

To take it down again:

```powershell
tailscale serve --https=443 localhost:<port> off
```

Notes worth knowing:

- WebSocket upgrades pass through `tailscale serve` unchanged, so live transcripts, sending and
  approvals all work over it.
- The certificate is issued for the machine's tailnet name, so the URL is stable across
  reboots and across changing tailnet IPs.
- `tailscale serve` publishes *within your tailnet*. It is not `tailscale funnel`, which would
  expose the host to the public internet — do not use funnel for this.
- On Windows the CLI lives at `C:\Program Files\Tailscale\tailscale.exe`; call it by full path
  if it is not on your `PATH`.

## 4. Install the app on the phone

Open the `https://…ts.net/` URL in Chrome on Android, then **⋮ → Add to Home screen** (Chrome
may also offer an install prompt on its own). It launches standalone from the home screen icon.

Over plain HTTP the app still works as an ordinary web page — it just never offers to install.
That is a supported way to use it, not a broken state.

## 5. Pair the phone with the host

Paste the pairing token from step 1 into the pairing screen once. The phone stores it and sends
it with every request to that host.

The origin is the host's identity: pairing an origin you already saved re-pairs that entry
rather than creating a second one, so a regenerated token is a re-pair, not a fresh setup.

## 6. Add each further PC as a host

Repeat steps 1–3 and 5 on the second PC — enable its server, `tailscale serve` its port, note
its own token — then, in the app you already installed, open the **host switcher** and add it by
origin. You do not install a second app: one installed client holds a list of hosts and switches
between them.

One rule decides which addresses can work together:

> An HTTPS page cannot open a plain-HTTP or `ws:` connection.

So an app installed from a `ts.net` HTTPS origin can only reach hosts that also speak HTTPS.
The app names that situation explicitly rather than letting it look like an offline PC, and the
fix is to run `tailscale serve` on the other host too. (Opening that host's own plain-HTTP URL
directly also works, but it is a separate origin with its own saved host list, so you would be
leaving the installed app.)

## The security model

Two independent layers, and it is worth being precise about which one does what:

- **The tailnet decides reachability.** Only devices on your tailnet can open a connection to
  the host at all. Toucan is never exposed to the public internet.
- **The pairing token decides authorization.** A device on your tailnet is *reachable*, not
  *trusted*. Every `/api` request and every chat socket presents the token; without it, a caller
  learns nothing but `401`. There are no cookies and no sessions — the token is the whole story.

Consequences to keep in mind:

- **Regenerate revokes.** Regenerating the token on a PC locks out every phone holding the old
  one and closes every live socket immediately. That is the way to revoke a lost phone.
- A revoked token costs exactly one host. The phone drops that PC into re-pairing and keeps
  working against the others.
- Tokens are per host and stored in the phone's browser storage for that origin.
- The static client bundle — the page, its assets, the manifest and the service worker — is
  served without a token, because a browser cannot set a header on the navigation that loads the
  pairing screen. It carries no workspace data; the API behind it stays shut.
- What the phone caches is the app shell and the content-hashed bundle assets, nothing else. No
  transcript, chat list or pairing verdict is ever served from a cache, so an installed app that
  cannot reach its host reports an offline host rather than showing you a stale workspace.

## When something does not work

| What you see | What it usually means |
| --- | --- |
| The pairing screen never loads | Tailscale is not up on one of the devices, or the PC's remote server is off. |
| `503` with "has not been built" | Run `npm run build:mobile` on that PC. |
| Chrome never offers to install | The page is not on an HTTPS origin. Check `tailscale serve status`. |
| A host shows as blocked by the page scheme | The app is on HTTPS and that host is saved as `http://`. Run `tailscale serve` on it. |
| A host asks to pair again | Its token was regenerated, or Toucan was reinstalled on that PC. |
| The host list is empty after reinstalling the app | Saved hosts live in browser storage for that origin; installing from a different origin starts a fresh list. |
