# Flow Mover for Homey

Copy your flows and advanced flows from one Homey (e.g. a Homey Pro 2023) to another (e.g. Homey Self-Hosted Server), with devices, variables, zones, users and folders matched automatically.

Homey has a hidden export/import in the web app (hold ALT on the "…" menu), but the imported flows still point to the device ids of the old Homey. A device that is added again on another Homey gets a new id, so those cards break. Flow Mover rewrites all ids for you.

## How it works

Install the app on the Homey that should **receive** the flows (e.g. the Self-Hosted Server), then open **Apps → Flow Mover → Configure app**.

1. **Connect**: to the other Homey (read) and to this Homey (an API key of this Homey with all permissions is needed for creating things: Homey only lets an app read its own Homey)
   - **The other Homey**: its IP address and an API key of that Homey (my.homey.app → select the old Homey → Settings → API Keys → New API Key, read access to Devices, Flows, Logic, Zones, Users (also for favorites) and Dashboards, plus the Apps permission if you want to copy the Compact Widgets settings).
2. **What is missing**: the apps of the other Homey that are not installed on this Homey, with where they are used (flows, dashboards, devices and how many of those are already here via Homey Link); unused ones can be shown with a tick box (with the API key of this Homey, App Store apps are installed directly; otherwise, or when that fails, the App Store page opens; apps installed with the Homey CLI are listed with the command to install them), apps that have an older version here than on the other Homey (App Store apps are updated the same way; flow cards of newer versions may otherwise be missing), devices of Homey's own types (device groups can be rebuilt here with one button, with their matched members; Matter devices and other built-in types are listed with what to do), users (Homey users are tied to their own Homey account, so they are invited: an invitation with the same role is created and you send the link; after accepting they are recognised by their account and flows with that user are converted), and the variables that don't exist here yet (create the ticked ones with one button)
3. **Match devices**: every device of the other Homey is matched to one device here (one to one): first via Homey Link (a linked device remembers the original device), then by name + room (full zone path), then — for several devices with the same name — by their current values (a Homey Link device mirrors the values of the original: temperatures, energy totals, on/off and dim levels), then by name when that is unambiguous. Doubtful ones (several devices with the same name) are left for you to choose, with the devices of the same name on top; the choice is remembered.
4. **Rooms and zones**: rebuilds the zone structure of the other Homey (floors, rooms, same icons) and moves every matched device into the same room as on the other Homey — handy after importing devices with Homey Link, which puts them all in the root zone. Zones are matched by their path of names, so existing zones are reused. Members of a device group (which Homey won't move on their own) are taken out of their group for a moment, moved, and put back
5. **Choose and move flows**: every flow shows its status
   - ✓ ready
   - ! remark (e.g. a variable will be created, a "start flow" card points to a flow that is not moved)
   - ✕ problem: unmatched device, app not installed on this Homey, or a card that does not exist on this Homey (checked against the real list of flow cards of this Homey)
   - = a flow with this name already exists

   Move the selected flows with one button.
6. **Switch over**: the moved flows are created disabled. Switch them per group: the flow here (and its bridge flow) is enabled, the original on the other Homey disabled — or back again. Needs write access to Flows in the API key of the other Homey
7. **Dashboards**: copies dashboards with all widgets, with device, zone and flow ids converted. Optionally also copies (via Compact Widgets 0.11+) the settings of the [Compact Widgets](https://github.com/lucje-81/homey_compact_widgets) app (gauge panels, icons, chosen values), with device ids converted, so those widgets work at once. Columns and widgets get new ids; a dashboard with an existing name is created as "(copy)"

8. **Favorites**: adds your favorite devices and flows of the other Homey to your favorites here (owner account, ids converted, nothing removed, items that cannot be converted are skipped). Do this last so the flows exist. Other users set their own favorites.

## Bridge flows (Homey Pro as Zigbee/Z-Wave bridge)

Devices that stay on the other Homey and come here through Homey Link only offer their values, not the special triggers of their app (e.g. "a button is pressed" on a remote). For such a flow the app creates a **bridge**:

- here: the flow, with that trigger replaced by "This flow is started", in the folder **Bridge from Pro**
- on the other Homey: a small flow with the original trigger (including its settings) and the Homey Link card "Start flow" on this Homey, in the folder **Bridge to SHS**

Only one such trigger per flow, and its tokens may not be used elsewhere in the flow. The Homey to start flows on is taken from the Homey Link app of the other Homey.

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
- HomeyScript scripts, Better Logic variables, moods, Insights history, Energy settings and the settings of other apps are not copied, only the flows and dashboards that use them.

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
