import Feature from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import Point from 'ol/geom/Point';
import Modify from 'ol/interaction/Modify.js';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import {unByKey} from 'ol/Observable';
import {Circle as CircleStyle, Fill, Stroke, Style} from 'ol/style';

const WORKER_URL = '/contour-detection-worker.js';

function pixelsClose(a, b, threshold = 14) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) <= threshold;
}

function mergeSegments(segments, liveSegment = []) {
  const merged = [];

  for (const segment of [...segments, liveSegment]) {
    for (const coordinate of segment) {
      const previous = merged[merged.length - 1];

      if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) {
        merged.push(coordinate);
      }
    }
  }

  return merged;
}

function distanceToSegment(pixel, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];

  if (dx === 0 && dy === 0) {
    return Math.hypot(pixel[0] - a[0], pixel[1] - a[1]);
  }

  const t = Math.max(0, Math.min(1, ((pixel[0] - a[0]) * dx + (pixel[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  const projection = [a[0] + t * dx, a[1] + t * dy];
  return Math.hypot(pixel[0] - projection[0], pixel[1] - projection[1]);
}

function createSnapshotCanvas(map) {
  const size = map.getSize();
  if (!size) {
    return null;
  }

  const [width, height] = size;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d', {willReadFrequently: true});
  if (!context) {
    return null;
  }

  const canvases = map.getViewport().querySelectorAll('.ol-layer canvas, canvas.ol-layer');

  for (const sourceCanvas of canvases) {
    if (!sourceCanvas.width || !sourceCanvas.height) {
      continue;
    }

    const opacity = sourceCanvas.parentElement?.style.opacity || sourceCanvas.style.opacity || '1';
    const transformMatch = sourceCanvas.style.transform.match(/^matrix\(([^)]*)\)$/);
    const matrix = transformMatch
      ? transformMatch[1].split(',').map(Number)
      : [1, 0, 0, 1, 0, 0];

    context.globalAlpha = Number(opacity);
    context.setTransform(...matrix);
    context.drawImage(sourceCanvas, 0, 0);
  }

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;

  return canvas;
}

function imageDataToTransferableSnapshot(imageData) {
  return {
    width: imageData.width,
    height: imageData.height,
    data: imageData.data.buffer.slice(0)
  };
}

export function createBasicPathPlugin(options = {}) {
  const strokeColor = options.color ?? '#ff5a36';
  const pathFeature = new Feature({geometry: new LineString([])});
  const pathSource = new VectorSource({features: [pathFeature]});
  const anchorSource = new VectorSource();
  const anchorFeatures = [];
  const listeners = new Set();

  const pathLayer = new VectorLayer({
    source: pathSource,
    style: new Style({
      stroke: new Stroke({
        color: strokeColor,
        width: options.width ?? 4
      })
    })
  });

  const anchorLayer = new VectorLayer({
    source: anchorSource,
    style(feature) {
      const isStart = feature.get('role') === 'start';
      return new Style({
        image: new CircleStyle({
          radius: isStart ? 7 : 6,
          fill: new Fill({
            color: isStart ? '#1f7a5a' : options.vertexFill ?? '#ffffff'
          }),
          stroke: new Stroke({
            color: strokeColor,
            width: 3
          })
        })
      });
    }
  });

  let map;
  let clickKey;
  let moveKey;
  let moveEndKey;
  let modifyInteraction;
  let worker;
  let workerReady = false;
  let requestId = 0;
  const pendingRequests = new Map();

  let anchors = [];
  let anchorPixels = [];
  let segments = [];
  let liveSegment = [];
  let closed = false;
  let busy = false;
  let status = 'Click the map to place the first magnetic anchor.';
  let imageReady = false;
  let previewInFlight = false;
  let previewPixel;
  let previewToken = 0;
  let destroyed = false;

  function getSnapshot() {
    return {
      pointCount: anchors.length,
      closed,
      busy,
      canClose: anchors.length >= 3 && !closed,
      hasPath: mergeSegments(segments, liveSegment).length > 0,
      status
    };
  }

  function notify() {
    const snapshot = getSnapshot();
    listeners.forEach((listener) => listener(snapshot));
  }

  function setStatus(nextStatus, nextBusy = busy) {
    status = nextStatus;
    busy = nextBusy;
    notify();
  }

  function syncAnchorFeatures() {
    anchorFeatures.forEach((feature) => anchorSource.removeFeature(feature));
    anchorFeatures.length = 0;

    anchors.forEach((coordinate, index) => {
      const feature = new Feature({geometry: new Point(coordinate)});
      feature.set('role', index === 0 ? 'start' : 'anchor');
      anchorFeatures.push(feature);
      anchorSource.addFeature(feature);
    });
  }

  function syncPathGeometry() {
    pathFeature.getGeometry().setCoordinates(mergeSegments(segments, liveSegment));
    syncAnchorFeatures();
    notify();
  }

  function getAnchorPixels() {
    if (!map) {
      return [];
    }

    return anchors.map((coordinate) => map.getPixelFromCoordinate(coordinate)).filter(Boolean);
  }

  async function buildSegmentBetweenPixels(startPixel, endPixel) {
    await callWorker('buildMap', {
      x: Math.round(startPixel[0]),
      y: Math.round(startPixel[1])
    });

    const contourPixels = await getContourPixels(endPixel);
    const contourCoordinates = pixelsToCoordinates(contourPixels);

    if (contourCoordinates.length >= 2) {
      return contourCoordinates;
    }

    const startCoordinate = map?.getCoordinateFromPixel(startPixel);
    const endCoordinate = map?.getCoordinateFromPixel(endPixel);
    return startCoordinate && endCoordinate ? [startCoordinate, endCoordinate] : [];
  }

  async function rebuildSegmentsFromAnchors(nextStatus) {
    if (!map) {
      return false;
    }

    anchorPixels = getAnchorPixels();
    liveSegment = [];
    resetPreviewState();

    if (anchors.length <= 1) {
      segments = [];
      syncPathGeometry();
      setStatus(nextStatus, false);
      return true;
    }

    await analyzeCurrentView();

    const nextSegments = [];
    const segmentCount = closed ? anchors.length : anchors.length - 1;

    for (let index = 0; index < segmentCount; index += 1) {
      const startPixel = anchorPixels[index];
      const endPixel = anchorPixels[(index + 1) % anchors.length];
      if (!startPixel || !endPixel) {
        continue;
      }

      nextSegments.push(await buildSegmentBetweenPixels(startPixel, endPixel));
    }

    segments = nextSegments;
    anchorPixels = getAnchorPixels();

    if (!closed && anchors.length > 0) {
      await rebuildMapFromLastAnchor();
    }

    syncPathGeometry();
    setStatus(nextStatus, false);
    return true;
  }

  function getNearestClosedSegmentIndex(pixel) {
    if (!map || !closed || segments.length === 0) {
      return -1;
    }

    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    segments.forEach((segment, index) => {
      const segmentPixels = segment
        .map((coordinate) => map.getPixelFromCoordinate(coordinate))
        .filter(Boolean);

      for (let pointIndex = 1; pointIndex < segmentPixels.length; pointIndex += 1) {
        const distance = distanceToSegment(pixel, segmentPixels[pointIndex - 1], segmentPixels[pointIndex]);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      }
    });

    return bestDistance <= 14 ? bestIndex : -1;
  }

  function createWorkerIfNeeded() {
    if (worker) {
      return worker;
    }

    worker = new Worker(WORKER_URL);
    worker.addEventListener('message', (event) => {
      const {id, ok, result, error} = event.data;
      const pending = pendingRequests.get(id);
      if (!pending) {
        return;
      }

      pendingRequests.delete(id);
      if (ok) {
        pending.resolve(result);
      } else {
        pending.reject(new Error(error || 'Contour worker request failed.'));
      }
    });
    worker.addEventListener('error', (event) => {
      const message = event.message || 'Contour worker crashed.';
      pendingRequests.forEach(({reject}) => reject(new Error(message)));
      pendingRequests.clear();
    });

    return worker;
  }

  function callWorker(type, payload = {}, transfer = []) {
    if (destroyed) {
      return Promise.reject(new Error('Plugin has been destroyed.'));
    }

    const nextWorker = createWorkerIfNeeded();
    const id = ++requestId;

    return new Promise((resolve, reject) => {
      pendingRequests.set(id, {resolve, reject});
      nextWorker.postMessage({id, type, payload}, transfer);
    });
  }

  async function ensureWorkerReady() {
    if (workerReady) {
      return;
    }

    await callWorker('init', {
      options: {
        gridStep: options.gridStep ?? 2,
        searchPadding: options.searchPadding ?? 52,
        maxSearchPadding: options.maxSearchPadding ?? 136,
        edgeBias: options.edgeBias ?? 8,
        lineBias: options.lineBias ?? 1.35
      }
    });
    workerReady = true;
  }

  async function analyzeCurrentView() {
    if (!map) {
      throw new Error('Map is not attached.');
    }

    setStatus('Capturing the current map view...', true);
    const snapshotCanvas = createSnapshotCanvas(map);
    if (!snapshotCanvas) {
      throw new Error('Unable to capture the current map view.');
    }

    setStatus('Reading pixels from the current map view...', true);
    const context = snapshotCanvas.getContext('2d', {willReadFrequently: true});
    if (!context) {
      throw new Error('Unable to read the current map view.');
    }

    const imageData = context.getImageData(0, 0, snapshotCanvas.width, snapshotCanvas.height);
    const snapshot = imageDataToTransferableSnapshot(imageData);

    setStatus('Initializing contour detection in the worker...', true);
    await ensureWorkerReady();

    setStatus('Analyzing the current map view in the worker...', true);
    await callWorker('analyzeImage', snapshot, [snapshot.data]);

    imageReady = true;
  }

  async function rebuildMapFromLastAnchor() {
    const lastAnchorPixel = anchorPixels[anchorPixels.length - 1];
    if (!imageReady || !lastAnchorPixel) {
      return;
    }

    setStatus('Preparing the contour model from the current anchor...', true);
    await callWorker('buildMap', {
      x: Math.round(lastAnchorPixel[0]),
      y: Math.round(lastAnchorPixel[1])
    });
  }

  async function getContourPixels(targetPixel) {
    const result = await callWorker('getContour', {
      x: Math.round(targetPixel[0]),
      y: Math.round(targetPixel[1])
    });

    return result.points ?? [];
  }

  function pixelsToCoordinates(points) {
    if (!map) {
      return [];
    }

    return points
      .map((pixel) => map.getCoordinateFromPixel(pixel))
      .filter(Boolean);
  }

  function resetPreviewState() {
    previewPixel = undefined;
    previewInFlight = false;
    previewToken += 1;
  }

  function getSnapTargetPixel(pixel) {
    if (anchors.length >= 3 && pixelsClose(pixel, anchorPixels[0])) {
      return anchorPixels[0];
    }

    return pixel;
  }

  async function runPreviewLoop() {
    if (previewInFlight || !previewPixel || !imageReady || busy || closed || anchors.length === 0) {
      return;
    }

    previewInFlight = true;

    while (previewPixel && !busy && !closed && anchors.length > 0 && imageReady) {
      const targetPixel = previewPixel;
      previewPixel = undefined;
      const token = ++previewToken;

      try {
        const contourPixels = await getContourPixels(targetPixel);
        if (token !== previewToken) {
          continue;
        }

        liveSegment = pixelsToCoordinates(contourPixels);
        if (liveSegment.length > 0) {
          const hoveringStart = targetPixel === anchorPixels[0] && anchors.length >= 3;
          setStatus(
            hoveringStart
              ? 'Click to close the path along the detected contour.'
              : 'Move the pointer to preview the detected contour, then click to lock it.',
            false
          );
          syncPathGeometry();
        }
      } catch (error) {
        console.error('Contour preview failed:', error);
        setStatus('Contour preview failed.', false);
        liveSegment = [];
        syncPathGeometry();
      }
    }

    previewInFlight = false;
    if (previewPixel) {
      void runPreviewLoop();
    }
  }

  async function refreshMagneticModel() {
    if (!map || anchors.length === 0 || closed) {
      return;
    }

    try {
      anchorPixels = anchors.map((coordinate) => map.getPixelFromCoordinate(coordinate));
      await analyzeCurrentView();
      await rebuildMapFromLastAnchor();
      liveSegment = [];
      setStatus('Contour detection ready. Move the pointer to follow visible contours.', false);
      syncPathGeometry();
    } catch (error) {
      console.error('Contour refresh failed:', error);
      setStatus(`Contour refresh failed: ${error.message}`, false);
    }
  }

  async function startPath(pixel) {
    const coordinate = map?.getCoordinateFromPixel(pixel);
    if (!coordinate) {
      return false;
    }

    try {
      anchors = [coordinate];
      anchorPixels = [pixel];
      segments = [];
      liveSegment = [];
      closed = false;
      resetPreviewState();
      await analyzeCurrentView();
      await rebuildMapFromLastAnchor();
      setStatus('Contour detection ready. Move the pointer to trace the path.', false);
      syncPathGeometry();
      return true;
    } catch (error) {
      console.error('Contour initialization failed:', error);
      setStatus(`Contour initialization failed: ${error.message}`, false);
      return false;
    }
  }

  async function lockSegment(pixel) {
    if (!map || anchors.length === 0) {
      return false;
    }

    const targetPixel = getSnapTargetPixel(pixel);
    const contourPixels = await getContourPixels(targetPixel);
    const snappedSegment = pixelsToCoordinates(contourPixels);

    if (snappedSegment.length < 2) {
      return false;
    }

    segments = [...segments, snappedSegment];
    liveSegment = [];
    resetPreviewState();

    if (targetPixel === anchorPixels[0]) {
      closed = true;
      setStatus('Path closed. Drag nodes to move them, or Shift-click the path to insert a new one.', false);
      syncPathGeometry();
      return true;
    }

    const coordinate = map.getCoordinateFromPixel(targetPixel);
    if (!coordinate) {
      return false;
    }

    anchors = [...anchors, coordinate];
    anchorPixels = [...anchorPixels, targetPixel];

    try {
      await rebuildMapFromLastAnchor();
      setStatus('Anchor locked. Move the pointer to trace the next segment.', false);
    } catch (error) {
      console.error('Contour map rebuild failed:', error);
      setStatus(`Anchor locked, but rebuilding failed: ${error.message}`, false);
    }

    syncPathGeometry();
    return true;
  }

  async function handleClick(event) {
    if (busy) {
      return;
    }

    if (closed) {
      if (event.originalEvent?.shiftKey) {
        await handleClosedPathInsert(event);
        return;
      }

      setStatus('Path closed. Drag nodes to move them, or Shift-click the path to insert a new one.', false);
      return;
    }

    if (anchors.length === 0) {
      await startPath(event.pixel);
      return;
    }

    try {
      setStatus('Locking the current contour segment...', true);
      await lockSegment(event.pixel);
    } catch (error) {
      console.error('Contour lock failed:', error);
      setStatus(`Locking the contour failed: ${error.message}`, false);
    }
  }

  function handlePointerMove(event) {
    if (!map || !imageReady || busy || closed || anchors.length === 0 || event.dragging) {
      return;
    }

    previewPixel = getSnapTargetPixel(event.pixel);
    void runPreviewLoop();
  }

  async function handleClosedPathInsert(event) {
    if (!map || busy || !closed) {
      return;
    }

    const clickedPath = map.forEachFeatureAtPixel(
      event.pixel,
      (feature) => feature,
      {
        layerFilter: (layer) => layer === pathLayer,
        hitTolerance: 8
      }
    );

    if (clickedPath !== pathFeature) {
      return;
    }

    const insertionIndex = getNearestClosedSegmentIndex(event.pixel);
    if (insertionIndex < 0) {
      return;
    }

    const coordinate = map.getCoordinateFromPixel(event.pixel);
    if (!coordinate) {
      return;
    }

    event.preventDefault();
    anchors.splice(insertionIndex + 1, 0, coordinate);
    syncAnchorFeatures();

    try {
      setStatus('Inserting a new node into the closed path...', true);
      await rebuildSegmentsFromAnchors('Node inserted. Drag nodes to continue editing the closed path.');
    } catch (error) {
      console.error('Closed-path insertion failed:', error);
      setStatus(`Inserting the node failed: ${error.message}`, false);
    }
  }

  async function handleAnchorModifyEnd() {
    if (!closed || !map) {
      return;
    }

    anchors = anchorFeatures.map((feature) => feature.getGeometry().getCoordinates());

    try {
      setStatus('Rebuilding the closed path after moving a node...', true);
      await rebuildSegmentsFromAnchors('Path updated. Drag nodes or Shift-click the path to keep editing.');
    } catch (error) {
      console.error('Closed-path edit failed:', error);
      setStatus(`Updating the path failed: ${error.message}`, false);
      syncAnchorFeatures();
    }
  }

  function clearState() {
    anchors = [];
    anchorPixels = [];
    segments = [];
    liveSegment = [];
    closed = false;
    imageReady = false;
    resetPreviewState();
    setStatus('Click the map to place the first magnetic anchor.', false);
    syncPathGeometry();
  }

  return {
    id: 'basic-path-plugin',
    layer: pathLayer,
    feature: pathFeature,
    subscribe(listener) {
      listeners.add(listener);
      listener(getSnapshot());
      return () => listeners.delete(listener);
    },
    canClosePath() {
      return anchors.length >= 3 && !closed;
    },
    getPointCount() {
      return anchors.length;
    },
    isClosed() {
      return closed;
    },
    async closePath() {
      if (!this.canClosePath()) {
        return false;
      }

      setStatus('Closing the path along the detected contour...', true);
      return lockSegment(anchorPixels[0]);
    },
    clearPoints() {
      clearState();
    },
    enableClickDrawing(targetMap) {
      map = targetMap;
      clickKey = map.on('click', (event) => {
        void handleClick(event);
      });
      moveKey = map.on('pointermove', handlePointerMove);
      moveEndKey = map.on('moveend', () => {
        void refreshMagneticModel();
      });
      modifyInteraction = new Modify({
        source: anchorSource,
        condition: () => closed && !busy
      });
      modifyInteraction.on('modifystart', () => {
        setStatus('Dragging a node. Release to rebuild the closed path.', false);
      });
      modifyInteraction.on('modifyend', () => {
        void handleAnchorModifyEnd();
      });
      map.addInteraction(modifyInteraction);
    },
    enableVertexEditing() {
      return null;
    },
    apply(targetMap) {
      map = targetMap;
      map.addLayer(pathLayer);
      map.addLayer(anchorLayer);
      return pathLayer;
    },
    destroy() {
      destroyed = true;
      workerReady = false;
      unByKey(clickKey);
      unByKey(moveKey);
      unByKey(moveEndKey);
      if (map && modifyInteraction) {
        map.removeInteraction(modifyInteraction);
      }
      pendingRequests.forEach(({reject}) => reject(new Error('Plugin destroyed.')));
      pendingRequests.clear();
      worker?.terminate();
      worker = undefined;
      listeners.clear();
    }
  };
}
