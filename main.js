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

const undoButton = document.createElement('button');
undoButton.type = 'button';
undoButton.className = 'map-button';
undoButton.textContent = 'Undo last point';
undoButton.addEventListener('click', async () => {
  await basicPathPlugin.undoLastPoint();
});

const clearButton = document.createElement('button');
clearButton.type = 'button';
clearButton.className = 'map-button';
clearButton.textContent = 'Clear path';
clearButton.addEventListener('click', () => {
  basicPathPlugin.clearPoints();
});

const closeButton = document.createElement('button');
closeButton.type = 'button';
closeButton.className = 'map-button';
closeButton.addEventListener('click', async () => {
  await basicPathPlugin.toggleClosed();
});

function updateControls(state) {
  instructions.textContent = state.status;
  closeButton.disabled = state.busy || (!state.canClose && !state.closed);
  closeButton.textContent = state.closed ? 'Reopen path' : 'Close path';
  undoButton.disabled = state.busy || state.pointCount === 0;
  clearButton.disabled = state.busy || !state.hasPath;
}

basicPathPlugin.subscribe(updateControls);

actions.append(undoButton, clearButton, closeButton);
controls.append(instructions, actions);
document.body.append(controls);
