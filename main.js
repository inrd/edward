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

const settings = document.createElement('div');
settings.className = 'map-settings';

const simplificationLabel = document.createElement('label');
simplificationLabel.className = 'map-field';

const simplificationLabelText = document.createElement('span');
simplificationLabelText.className = 'map-field-label';
simplificationLabelText.textContent = 'Simplification';

const simplificationSelect = document.createElement('select');
simplificationSelect.className = 'map-select';
simplificationSelect.addEventListener('change', () => {
  void basicPathPlugin.setSimplificationPreset(simplificationSelect.value);
});

const toggleButton = document.createElement('button');
toggleButton.type = 'button';
toggleButton.className = 'map-button';
toggleButton.addEventListener('click', () => {
  basicPathPlugin.setEnabled(!basicPathPlugin.isEnabled());
});

const clearButton = document.createElement('button');
clearButton.type = 'button';
clearButton.className = 'map-button';
clearButton.addEventListener('click', () => {
  basicPathPlugin.clearPoints();
});

function updateControls(state) {
  instructions.textContent = state.status;
  toggleButton.textContent = state.enabled ? 'Finish smart draw' : 'Start smart draw';
  toggleButton.classList.toggle('is-active', state.enabled);
  toggleButton.disabled = state.busy;

  clearButton.textContent = state.pointCount > 0 ? 'Discard current path' : 'Undo last path';
  clearButton.disabled = state.busy || !state.canUndo;

  if (simplificationSelect.options.length === 0) {
    for (const preset of state.simplificationPresets) {
      const option = document.createElement('option');
      option.value = preset;
      option.textContent = preset[0].toUpperCase() + preset.slice(1);
      simplificationSelect.append(option);
    }
  }

  simplificationSelect.value = state.activeSimplificationPreset;
  simplificationSelect.disabled = state.busy;
}

basicPathPlugin.subscribe(updateControls);

simplificationLabel.append(simplificationLabelText, simplificationSelect);
actions.append(toggleButton, clearButton);
settings.append(simplificationLabel);
controls.append(instructions, settings, actions);
document.body.append(controls);
