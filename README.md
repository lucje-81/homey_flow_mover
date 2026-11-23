# Flow Mover for Homey

Copy your flows and advanced flows from one Homey (e.g. a Homey Pro 2023) to another (e.g. Homey Self-Hosted Server), with devices, variables, zones, users and folders matched automatically.

Homey has a hidden export/import in the web app (hold ALT on the "…" menu), but the imported flows still point to the device ids of the old Homey. A device that is added again on another Homey gets a new id, so those cards break. Flow Mover rewrites all ids for you.

## How it works

Install the app on the Homey that should **receive** the flows (e.g. the Self-Hosted Server), then open **Apps → Flow Mover → Configure app**.

1. **Connect to the other Homey**: its IP address and an API key of that Homey (my.homey.app → select the old Homey → Settings → API Keys → New API Key, read access to Devices, Flows, Logic, Zones, Users and Apps is enough).
2. **What is missing**: the apps your flows use that are not installed on this Homey (App Store apps can be installed with one button, apps installed with the Homey CLI are listed with the command to install them), and the variables that don't exist here yet (create the ticked ones with one button)
3. **Match devices**: every device used in your flows is matched to the device with the same name on this Homey (preferring the same app and zone). Unmatched or wrong matches can be chosen by hand; the choice is remembered.
4. **Choose and move flows**: every flow shows its status
   - ✓ ready
   - ! remark (e.g. a variable will be created, a "start flow" card points to a flow that is not moved)
   - ✕ problem: unmatched device, app not installed on this Homey, or a card that does not exist on this Homey (checked against the real list of flow cards of this Homey)
   - = a flow with this name already exists

   Move the selected flows with one button.

## What it does when moving

- Recreates the folder structure (by name)
- Creates missing variables (same name, type and current value) — optional
- Rewrites every id in the flow: device cards, device tags (`[[homey:device:…|measure_power]]`), variables, zones, users, and "start flow" cards (also between flows moved in the same run)
- Fixes cards that still carry an outdated device id in `id` while `ownerUri` points to the current device (happens after replacing a device; Homey uses `ownerUri`)
- Creates the flows **disabled** by default, so they don't run twice while the old Homey still runs them; enable them after switching off the old ones (or tick "Create flows enabled")
- Skips flows that already exist (same name) — optional
- Never changes anything on the source Homey (read-only API key)

## Limitations

- Apps used in your flows must be installed on the target Homey; devices must exist there (added directly or via Homey Link). Devices linked via Homey Link may not offer the special flow cards of their app — the analysis shows such cards as ✕.
- Matching is by name; give devices the same name on both Homeys or choose the match by hand.
- HomeyScript scripts, Better Logic variables and other app data are not copied, only the flows that use them.

## Install

```bash
git clone https://github.com/lucje-81/homey_flow_mover.git
cd homey_flow_mover
npm install
homey app install
```

Choose the Self-Hosted Server (or the Homey that should receive the flows) when the Homey CLI asks which Homey to use (`homey select`).

## License

MIT — Luc Van Laer
