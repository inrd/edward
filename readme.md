# Edward

Edward is a contour-aware tracing plugin for OpenLayers. It captures the rendered map, extracts image gradients in a worker, and snaps interactive path tracing to visible contours.

## Install

```bash
npm install edward ol
```

## Integrate with OpenLayers

```js
import {Map, View} from 'ol';
import TileLayer from 'ol/layer/Tile';
import OSM from 'ol/source/OSM';
import {createEdwardPlugin} from 'edward';

const map = new Map({
  target: 'map',
  layers: [
    new TileLayer({source: new OSM()})
  ],
  view: new View({
    center: [0, 0],
    zoom: 2
  })
});

const edward = createEdwardPlugin();
edward.apply(map);
edward.enableClickDrawing(map);
edward.setEnabled(true);
```

If your application already owns a `VectorSource`, you can inject it so Edward writes committed polygons into your existing editing pipeline:

```js
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';

const outputSource = new VectorSource();
map.addLayer(new VectorLayer({source: outputSource}));

const edward = createEdwardPlugin({outputSource});
edward.apply(map);
edward.enableClickDrawing(map);
```

## Add UI controls

Edward does not render controls for you. The host application is expected to provide its own buttons, selects, and status display, then connect them to the plugin API.

```js
const status = document.createElement('div');
const toggle = document.createElement('button');
const clear = document.createElement('button');
const preset = document.createElement('select');

toggle.addEventListener('click', () => {
  edward.setEnabled(!edward.isEnabled());
});

clear.addEventListener('click', () => {
  edward.clearPoints();
});

preset.addEventListener('change', () => {
  void edward.setSimplificationPreset(preset.value);
});

edward.subscribe((state) => {
  status.textContent = state.status;
  toggle.textContent = state.enabled ? 'Finish trace' : 'Start trace';
  toggle.disabled = state.busy;
  clear.disabled = state.busy || !state.canUndo;
  preset.value = state.activeSimplificationPreset;
  preset.disabled = state.busy;
});
```

The subscribed state includes `status`, `enabled`, `busy`, `canUndo`, `pointCount`, `completedPathCount`, `activeSimplificationPreset`, and `simplificationPresets`.

## Local development

To run the demo locally:

```bash
npm install
npm start
```

To build the publishable library:

```bash
npm run build
```

This writes the package entry and worker asset to `dist/`.
