# homebridge-pvs6-tiles

Shows your SunPower / SunStrong **PVS6** data as **number tiles in the Apple Home app**.

HomeKit has no "watts" tile, so each tile is a **light sensor where lux = watts**. A tile reading `3,420 lx` means 3,420 W.

| Tile | Shows | Default |
| --- | --- | --- |
| **House Usage** | Total power your house is using right now (solar + grid, including EV charging) | On |
| **Solar Now** | Solar production right now | Off |
| **Grid Buying** / **Grid Selling** | Power coming from / going to the utility | Off |
| **Solar Today Wh** | Solar produced since midnight, in Wh (24,350 = 24.35 kWh) | Off |

## Requirements

- A PVS6 on your network (the same one homebridge-pvs6 uses)
- Homebridge 1.8+ or 2.x

## Install

Copy `homebridge-pvs6-tiles-1.0.0.tgz` to your Homebridge machine:

```
scp homebridge-pvs6-tiles-1.0.0.tgz pi@homebridge.local:/tmp/
```

Then in the Homebridge UI terminal:

```
sudo hb-service add /tmp/homebridge-pvs6-tiles-1.0.0.tgz
```

If `hb-service` isn't available on your setup:

```
cd /var/lib/homebridge && npm install /tmp/homebridge-pvs6-tiles-1.0.0.tgz
```

## Configure

Open **Plugins → PVS6 Number Tiles → Settings**.

**Host and Serial Number can stay blank.** The plugin reuses the Host and Serial Number from your homebridge-pvs6 settings (or its discovery cache). Choose any extra tiles, save, run it as a **child bridge**, and restart.

```json
{
  "platform": "PVS6Tiles",
  "name": "PVS6 Tiles",
  "pollInterval": 30,
  "solarTile": false,
  "gridTiles": false,
  "solarTodayTile": true
}
```

The log should show `Using PVS6 at ... (from homebridge-pvs6 settings)` and `Connected to PVS6`.

## Add to Apple Home

Scan the new child bridge's QR code in the Home app (**+ → Add Accessory**). Then long-press each tile and turn on **Show in Home View** or **Include in Favorites** so the numbers sit on the Home tab.

## Notes

- **Don't add the Tesla charger's watts to House Usage.** The PVS6 measures the whole panel, so car charging is already included.
- The Home app shows the unit as "lx". Renaming a tile to something like "House Usage W" makes it clearer.
- HomeKit's minimum light level is 0.0001, so a zero reading (for example Solar Now at night) displays as 0.0001 lx.
- **Solar Today** counts from the first reading after midnight. On the day you install it, it only counts from install time.
- The PVS6 is also polled by homebridge-pvs6 and the Sunflower app. Keep the interval at 30 seconds or more. If you see `socket hang up` errors, raise it to 60.
- You can use the tiles in automations, for example "when Grid Selling rises above 3,000, turn on the pool pump."

## Credits

PVS6 local API client adapted from [homebridge-pvs6](https://github.com/dacarson/homebridge-pvs6) by David Carson (MIT License).

Author: Dennis Valansi
