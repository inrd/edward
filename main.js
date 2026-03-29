import './style.css';
import {Map, View} from 'ol';
import TileLayer from 'ol/layer/Tile';
import OSM from 'ol/source/OSM';
import {fromLonLat} from 'ol/proj';
import {createBasicPathPlugin} from './plugins/basicPathPlugin.js';

const map = new Map({
  target: 'map',
  layers: [
    new TileLayer({
      source: new OSM()
    })
  ],
  view: new View({
    center: fromLonLat([2.3522, 48.8566]),
    zoom: 4
  })
});

const basicPathPlugin = createBasicPathPlugin();
basicPathPlugin.apply(map);
basicPathPlugin.enableClickDrawing(map);

const controls = document.createElement('div');
controls.className = 'map-controls';

const instructions = document.createElement('div');
instructions.className = 'map-instructions';

const actions = document.createElement('div');
actions.className = 'map-actions';

const clearButton = document.createElement('button');
clearButton.type = 'button';
clearButton.className = 'map-button';
clearButton.textContent = 'Clear path';
clearButton.addEventListener('click', () => {
  basicPathPlugin.clearPoints();
});

function updateControls(state) {
  instructions.textContent = state.status;
  clearButton.disabled = state.busy || !state.hasPath;
}

basicPathPlugin.subscribe(updateControls);

actions.append(clearButton);
controls.append(instructions, actions);
document.body.append(controls);
