import Feature from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import Point from 'ol/geom/Point';
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
  const source = new VectorSource({features: [pathFeature]});
  const anchorFeatures = [];
  const listeners = new Set();

  const pathLayer = new VectorLayer({
    source,
    style(feature) {
      if (feature === pathFeature) {
        return new Style({
          stroke: new Stroke({
            color: strokeColor,
            width: options.width ?? 4
          })
        });
      }

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
    anchorFeatures.forEach((feature) => source.removeFeature(feature));
    anchorFeatures.length = 0;

    anchors.forEach((coordinate, index) => {
      const feature = new Feature({geometry: new Point(coordinate)});
      feature.set('role', index === 0 ? 'start' : 'anchor');
      anchorFeatures.push(feature);
      source.addFeature(feature);
    });
  }

  function syncPathGeometry() {
    pathFeature.getGeometry().setCoordinates(mergeSegments(segments, liveSegment));
    syncAnchorFeatures();
    notify();
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
      setStatus('Path closed. Undo the last point or clear it to keep editing.', false);
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
      setStatus('The path is closed. Undo the last point or clear it before adding more anchors.', false);
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
    async openPath() {
      if (!closed) {
        return false;
      }

      segments = segments.slice(0, -1);
      closed = false;
      liveSegment = [];
      resetPreviewState();
      await refreshMagneticModel();
      setStatus('Path reopened. Move the pointer to keep tracing.', false);
      syncPathGeometry();
      return true;
    },
    async toggleClosed() {
      if (closed) {
        return this.openPath();
      }

      return this.closePath();
    },
    async undoLastPoint() {
      if (closed) {
        return this.openPath();
      }

      if (anchors.length === 0) {
        return false;
      }

      if (anchors.length === 1) {
        clearState();
        return true;
      }

      anchors = anchors.slice(0, -1);
      anchorPixels = anchorPixels.slice(0, -1);
      segments = segments.slice(0, -1);
      liveSegment = [];
      resetPreviewState();
      await rebuildMapFromLastAnchor();
      setStatus('Last anchor removed.', false);
      syncPathGeometry();
      return true;
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
    },
    enableVertexEditing() {
      return null;
    },
    apply(targetMap) {
      map = targetMap;
      map.addLayer(pathLayer);
      return pathLayer;
    },
    destroy() {
      destroyed = true;
      workerReady = false;
      unByKey(clickKey);
      unByKey(moveKey);
      unByKey(moveEndKey);
      pendingRequests.forEach(({reject}) => reject(new Error('Plugin destroyed.')));
      pendingRequests.clear();
      worker?.terminate();
      worker = undefined;
      listeners.clear();
    }
  };
}
