import Feature from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import MultiPolygon from 'ol/geom/MultiPolygon';
import Point from 'ol/geom/Point';
import Polygon from 'ol/geom/Polygon';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import {unByKey} from 'ol/Observable';
import {Circle as CircleStyle, Fill, Stroke, Style} from 'ol/style';

const SIMPLIFICATION_PRESETS = {
  low: {
    simplifyTolerance: 0.85,
    simplifyMaxDeviation: 1.75,
    simplifyGradientBias: 0.5
  },
  mid: {
    simplifyTolerance: 1.15,
    simplifyMaxDeviation: 2.4,
    simplifyGradientBias: 0.4
  },
  high: {
    simplifyTolerance: 1.55,
    simplifyMaxDeviation: 3.2,
    simplifyGradientBias: 0.3
  }
};

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

function coordinatesEqual(a, b) {
  return Boolean(a && b && a[0] === b[0] && a[1] === b[1]);
}

function createClosedRing(coordinates) {
  if (coordinates.length < 3) {
    return null;
  }

  const ring = [...coordinates];
  const first = ring[0];
  const last = ring[ring.length - 1];

  if (!coordinatesEqual(first, last)) {
    ring.push(first);
  }

  return ring.length >= 4 ? ring : null;
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

function createDefaultWorker() {
  return new Worker(new URL('./contour-detection-worker.js', import.meta.url), {
    type: 'module'
  });
}

/**
 * @typedef {object} EdwardOptions
 * @property {VectorSource} [outputSource]
 * @property {string | URL} [workerUrl]
 * @property {() => Worker} [createWorker]
 */

/**
 * @param {EdwardOptions & Record<string, any>} [options]
 */
export function createEdwardPlugin(options = {}) {
  const strokeColor = options.color ?? '#ff5a36';
  const fillColor = options.fillColor ?? 'rgba(255, 90, 54, 0.18)';
  const committedFillColor = options.committedFillColor ?? 'rgba(255, 90, 54, 0.22)';
  const externalOutputSource = options.outputSource instanceof VectorSource ? options.outputSource : null;

  const pathFeature = new Feature({geometry: new LineString([])});
  const pathSource = new VectorSource({features: [pathFeature]});
  const anchorSource = new VectorSource();
  const sessionPolygonSource = new VectorSource();
  const outputSource = externalOutputSource ?? new VectorSource();
  const anchorFeatures = [];
  const sessionPolygonFeatures = [];
  const listeners = new Set();

  const sketchStroke = new Stroke({
    color: strokeColor,
    width: options.width ?? 4
  });

  const pathLayer = new VectorLayer({
    source: pathSource,
    style: new Style({
      stroke: sketchStroke
    })
  });

  const sessionPolygonLayer = new VectorLayer({
    source: sessionPolygonSource,
    style: new Style({
      stroke: sketchStroke,
      fill: new Fill({color: fillColor})
    })
  });

  const outputLayer = new VectorLayer({
    source: outputSource,
    style: new Style({
      stroke: new Stroke({
        color: strokeColor,
        width: options.width ?? 3
      }),
      fill: new Fill({color: committedFillColor})
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
  let worker;
  let workerReady = false;
  let requestId = 0;
  const pendingRequests = new Map();

  let enabled = false;
  let anchors = [];
  let anchorPixels = [];
  let segments = [];
  let liveSegment = [];
  let completedPolygons = [];
  let busy = false;
  let status = 'Edward is ready. Start a trace to follow map contours.';
  let imageReady = false;
  let previewInFlight = false;
  let previewPixel;
  let previewToken = 0;
  let destroyed = false;
  let activeSimplificationPreset = SIMPLIFICATION_PRESETS[options.simplificationPreset] ? options.simplificationPreset : 'low';

  function getSimplificationOptions() {
    return SIMPLIFICATION_PRESETS[activeSimplificationPreset];
  }

  function getWorkerOptions() {
    return {
      gridStep: options.gridStep ?? 2,
      searchPadding: options.searchPadding ?? 52,
      maxSearchPadding: options.maxSearchPadding ?? 136,
      edgeBias: options.edgeBias ?? 8,
      lineBias: options.lineBias ?? 1.35,
      turnBias: options.turnBias ?? 1.1,
      continuityBias: options.continuityBias ?? 1.35,
      guideBias: options.guideBias ?? 0.3,
      ...getSimplificationOptions()
    };
  }

  function getCurrentPathCoordinates() {
    return mergeSegments(segments, liveSegment);
  }

  function hasActiveSketch() {
    return anchors.length > 0 || segments.length > 0 || liveSegment.length > 0;
  }

  function getSnapshot() {
    return {
      enabled,
      pointCount: anchors.length,
      busy,
      canClose: anchors.length >= 3,
      hasPath: completedPolygons.length > 0 || getCurrentPathCoordinates().length > 0,
      canUndo: completedPolygons.length > 0 || hasActiveSketch(),
      completedPathCount: completedPolygons.length,
      status,
      activeSimplificationPreset,
      simplificationPresets: Object.keys(SIMPLIFICATION_PRESETS)
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

  function resetPreviewState() {
    previewPixel = undefined;
    previewInFlight = false;
    previewToken += 1;
  }

  function clearSketchState() {
    anchors = [];
    anchorPixels = [];
    segments = [];
    liveSegment = [];
    imageReady = false;
    resetPreviewState();
  }

  function syncAnchorFeatures() {
    anchorFeatures.forEach((feature) => anchorSource.removeFeature(feature));
    anchorFeatures.length = 0;

    if (anchors.length === 0) {
      return;
    }

    const feature = new Feature({geometry: new Point(anchors[0])});
    feature.set('role', 'start');
    anchorFeatures.push(feature);
    anchorSource.addFeature(feature);
  }

  function syncSessionPolygonFeatures() {
    sessionPolygonFeatures.forEach((feature) => sessionPolygonSource.removeFeature(feature));
    sessionPolygonFeatures.length = 0;

    for (const ring of completedPolygons) {
      const feature = new Feature({geometry: new Polygon([ring])});
      sessionPolygonFeatures.push(feature);
      sessionPolygonSource.addFeature(feature);
    }
  }

  function syncPathGeometry() {
    pathFeature.getGeometry().setCoordinates(getCurrentPathCoordinates());
    syncAnchorFeatures();
    syncSessionPolygonFeatures();
    notify();
  }

  function resolveWorker() {
    if (typeof options.createWorker === 'function') {
      return options.createWorker();
    }

    if (options.workerUrl) {
      return new Worker(options.workerUrl, {
        type: 'module'
      });
    }

    return createDefaultWorker();
  }

  function createWorkerIfNeeded() {
    if (worker) {
      return worker;
    }

    worker = resolveWorker();
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
      options: getWorkerOptions()
    });
    workerReady = true;
  }

  async function updateWorkerSettings() {
    await callWorker('init', {
      options: getWorkerOptions()
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

  function getSnapTargetPixel(pixel) {
    if (anchors.length >= 3 && pixelsClose(pixel, anchorPixels[0])) {
      return anchorPixels[0];
    }

    return pixel;
  }

  async function runPreviewLoop() {
    if (previewInFlight || !previewPixel || !imageReady || busy || anchors.length === 0 || !enabled) {
      return;
    }

    previewInFlight = true;

    while (previewPixel && !busy && anchors.length > 0 && imageReady && enabled) {
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
              ? 'Click to close this smart path.'
              : 'Move the pointer to preview the smart contour, then click to lock it.',
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
    if (!map || anchors.length === 0 || !enabled) {
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
      clearSketchState();
      anchors = [coordinate];
      anchorPixels = [pixel];
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

  async function finalizeClosedPath(snappedSegment) {
    const mergedPath = mergeSegments([...segments, snappedSegment]);
    const ring = createClosedRing(mergedPath);

    if (!ring) {
      return false;
    }

    completedPolygons = [...completedPolygons, ring];
    clearSketchState();
    setStatus('Path stored. Click to start another smart path, or toggle the tool off to commit.', false);
    syncPathGeometry();
    return true;
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

    if (targetPixel === anchorPixels[0]) {
      return finalizeClosedPath(snappedSegment);
    }

    segments = [...segments, snappedSegment];
    liveSegment = [];
    resetPreviewState();

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
    if (!enabled || busy) {
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
    if (!map || !imageReady || busy || anchors.length === 0 || event.dragging || !enabled) {
      return;
    }

    previewPixel = getSnapTargetPixel(event.pixel);
    void runPreviewLoop();
  }

  function resetSession(nextStatus = 'Edward is ready. Start a trace to follow map contours.') {
    clearSketchState();
    completedPolygons = [];
    setStatus(nextStatus, false);
    syncPathGeometry();
  }

  function commitCompletedPaths() {
    if (completedPolygons.length === 0) {
      return false;
    }

    const geometry = new MultiPolygon(completedPolygons.map((ring) => [ring]));
    outputSource.addFeature(new Feature({geometry}));
    return true;
  }

  return {
    id: 'edward',
    layer: pathLayer,
    feature: pathFeature,
    outputSource,
    outputLayer,
    subscribe(listener) {
      listeners.add(listener);
      listener(getSnapshot());
      return () => listeners.delete(listener);
    },
    canClosePath() {
      return anchors.length >= 3;
    },
    getPointCount() {
      return anchors.length;
    },
    isClosed() {
      return false;
    },
    async closePath() {
      if (!this.canClosePath() || !enabled) {
        return false;
      }

      setStatus('Closing the path along the detected contour...', true);
      return lockSegment(anchorPixels[0]);
    },
    clearPoints() {
      if (busy) {
        return false;
      }

      if (hasActiveSketch()) {
        clearSketchState();
        setStatus(
          completedPolygons.length > 0
            ? 'Current path discarded. Click to start another smart path, or toggle the tool off to commit.'
            : 'Current trace discarded. Click the map to place the first anchor.',
          false
        );
        syncPathGeometry();
        return true;
      }

      if (completedPolygons.length > 0) {
        completedPolygons = completedPolygons.slice(0, -1);
        setStatus(
          completedPolygons.length > 0
            ? 'Last stored path removed.'
            : 'Last stored trace removed. Click the map to place the first anchor.',
          false
        );
        syncPathGeometry();
        return true;
      }

      return false;
    },
    getSimplificationPreset() {
      return activeSimplificationPreset;
    },
    async setSimplificationPreset(nextPreset) {
      if (!SIMPLIFICATION_PRESETS[nextPreset] || nextPreset === activeSimplificationPreset || busy) {
        return activeSimplificationPreset;
      }

      activeSimplificationPreset = nextPreset;
      notify();

      try {
        await ensureWorkerReady();
        await updateWorkerSettings();

        if (enabled && anchors.length > 0) {
          await refreshMagneticModel();
          if (previewPixel) {
            void runPreviewLoop();
          }
        } else if (enabled) {
          setStatus('Simplification updated. Click the map to place the first anchor.', false);
        }
      } catch (error) {
        console.error('Updating simplification preset failed:', error);
        setStatus(`Updating simplification failed: ${error.message}`, false);
      }

      notify();
      return activeSimplificationPreset;
    },
    setEnabled(nextEnabled) {
      if (busy || enabled === nextEnabled) {
        return enabled;
      }

      enabled = nextEnabled;

      if (enabled) {
        resetSession('Edward tracing enabled. Click the map to place the first anchor.');
        notify();
        return enabled;
      }

      const committed = commitCompletedPaths();
      resetSession(
        committed
          ? 'Edward tracing disabled. MultiPolygon committed to the map.'
          : 'Edward tracing disabled.'
      );
      return enabled;
    },
    isEnabled() {
      return enabled;
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
      if (!externalOutputSource) {
        map.addLayer(outputLayer);
      }
      map.addLayer(sessionPolygonLayer);
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
      pendingRequests.forEach(({reject}) => reject(new Error('Edward plugin destroyed.')));
      pendingRequests.clear();
      worker?.terminate();
      worker = undefined;
      listeners.clear();
    }
  };
}
