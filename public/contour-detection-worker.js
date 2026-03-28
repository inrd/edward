let settings = {
  gridStep: 2,
  searchPadding: 52,
  maxSearchPadding: 136,
  edgeBias: 8,
  lineBias: 1.35
};

let model;
let anchorPoint;

function postSuccess(id, result = {}) {
  self.postMessage({id, ok: true, result});
}

function postFailure(id, error) {
  const message = error instanceof Error ? error.message : String(error);
  self.postMessage({id, ok: false, error: message});
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function buildGradientModel(payload) {
  const {width, height} = payload;
  const rgba = new Uint8ClampedArray(payload.data);
  const step = settings.gridStep;
  const gridWidth = Math.max(2, Math.ceil(width / step));
  const gridHeight = Math.max(2, Math.ceil(height / step));
  const grayscale = new Float32Array(gridWidth * gridHeight);
  const gradient = new Float32Array(gridWidth * gridHeight);

  for (let gridY = 0; gridY < gridHeight; gridY += 1) {
    for (let gridX = 0; gridX < gridWidth; gridX += 1) {
      const pixelX = Math.min(width - 1, gridX * step);
      const pixelY = Math.min(height - 1, gridY * step);
      const offset = (pixelY * width + pixelX) * 4;
      grayscale[gridY * gridWidth + gridX] =
        rgba[offset] * 0.299 +
        rgba[offset + 1] * 0.587 +
        rgba[offset + 2] * 0.114;
    }
  }

  let maxGradient = 1;
  for (let gridY = 1; gridY < gridHeight - 1; gridY += 1) {
    for (let gridX = 1; gridX < gridWidth - 1; gridX += 1) {
      const index = gridY * gridWidth + gridX;
      const gx =
        -grayscale[index - gridWidth - 1] + grayscale[index - gridWidth + 1] +
        -2 * grayscale[index - 1] + 2 * grayscale[index + 1] +
        -grayscale[index + gridWidth - 1] + grayscale[index + gridWidth + 1];
      const gy =
        -grayscale[index - gridWidth - 1] - 2 * grayscale[index - gridWidth] - grayscale[index - gridWidth + 1] +
        grayscale[index + gridWidth - 1] + 2 * grayscale[index + gridWidth] + grayscale[index + gridWidth + 1];
      const magnitude = Math.hypot(gx, gy);
      gradient[index] = magnitude;
      if (magnitude > maxGradient) {
        maxGradient = magnitude;
      }
    }
  }

  for (let index = 0; index < gradient.length; index += 1) {
    gradient[index] /= maxGradient;
  }

  return {
    width,
    height,
    step,
    gridWidth,
    gridHeight,
    gradient
  };
}

function pixelToGrid(point) {
  return [
    clamp(Math.round(point[0] / model.step), 0, model.gridWidth - 1),
    clamp(Math.round(point[1] / model.step), 0, model.gridHeight - 1)
  ];
}

function gridToPixel(point) {
  return [
    clamp(point[0] * model.step, 0, model.width - 1),
    clamp(point[1] * model.step, 0, model.height - 1)
  ];
}

function gradientAt(x, y) {
  return model.gradient[y * model.gridWidth + x];
}

function heuristic(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function distanceFromLine(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (dx === 0 && dy === 0) {
    return heuristic(point, start);
  }

  const numerator = Math.abs(dy * point[0] - dx * point[1] + end[0] * start[1] - end[1] * start[0]);
  const denominator = Math.hypot(dx, dy);
  return numerator / denominator;
}

function buildSearchBounds(start, end) {
  const distance = heuristic(start, end);
  const padding = Math.min(settings.maxSearchPadding, settings.searchPadding + Math.floor(distance * 0.2));
  return {
    minX: clamp(Math.min(start[0], end[0]) - padding, 0, model.gridWidth - 1),
    maxX: clamp(Math.max(start[0], end[0]) + padding, 0, model.gridWidth - 1),
    minY: clamp(Math.min(start[1], end[1]) - padding, 0, model.gridHeight - 1),
    maxY: clamp(Math.max(start[1], end[1]) + padding, 0, model.gridHeight - 1)
  };
}

function reconstructPath(cameFrom, currentKey) {
  const path = [];
  let key = currentKey;

  while (key !== undefined) {
    const point = cameFrom.points.get(key);
    path.push(gridToPixel(point));
    key = cameFrom.parents.get(key);
  }

  path.reverse();
  return path;
}

function findContourPath(targetPixel) {
  if (!model || !anchorPoint) {
    throw new Error('Contour model is not ready.');
  }

  const start = pixelToGrid(anchorPoint);
  const goal = pixelToGrid(targetPixel);
  const bounds = buildSearchBounds(start, goal);
  const open = [start];
  const queued = new Set([`${start[0]},${start[1]}`]);
  const scores = new Map([[`${start[0]},${start[1]}`, 0]]);
  const estimate = new Map([[`${start[0]},${start[1]}`, heuristic(start, goal)]]);
  const cameFrom = {
    parents: new Map(),
    points: new Map([[`${start[0]},${start[1]}`, start]])
  };
  const neighbors = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0],           [1, 0],
    [-1, 1],  [0, 1],  [1, 1]
  ];
  const iterationLimit = Math.max(6000, (bounds.maxX - bounds.minX + 1) * (bounds.maxY - bounds.minY + 1) * 2);
  let iterations = 0;

  while (open.length > 0 && iterations < iterationLimit) {
    iterations += 1;

    let bestIndex = 0;
    let bestKey = `${open[0][0]},${open[0][1]}`;
    let bestScore = estimate.get(bestKey) ?? Number.POSITIVE_INFINITY;

    for (let index = 1; index < open.length; index += 1) {
      const candidate = open[index];
      const candidateKey = `${candidate[0]},${candidate[1]}`;
      const candidateScore = estimate.get(candidateKey) ?? Number.POSITIVE_INFINITY;
      if (candidateScore < bestScore) {
        bestIndex = index;
        bestKey = candidateKey;
        bestScore = candidateScore;
      }
    }

    const current = open.splice(bestIndex, 1)[0];
    queued.delete(bestKey);

    if (current[0] === goal[0] && current[1] === goal[1]) {
      return reconstructPath(cameFrom, bestKey);
    }

    const currentScore = scores.get(bestKey) ?? Number.POSITIVE_INFINITY;

    for (const [dx, dy] of neighbors) {
      const nextX = current[0] + dx;
      const nextY = current[1] + dy;

      if (
        nextX < bounds.minX || nextX > bounds.maxX ||
        nextY < bounds.minY || nextY > bounds.maxY
      ) {
        continue;
      }

      const next = [nextX, nextY];
      const nextKey = `${nextX},${nextY}`;
      const edgeStrength = gradientAt(nextX, nextY);
      const movementCost = Math.hypot(dx, dy);
      const edgeCost = (1 - edgeStrength) * settings.edgeBias;
      const lineCost = distanceFromLine(next, start, goal) * settings.lineBias * 0.08;
      const tentativeScore = currentScore + movementCost + edgeCost + lineCost;

      if (tentativeScore >= (scores.get(nextKey) ?? Number.POSITIVE_INFINITY)) {
        continue;
      }

      cameFrom.parents.set(nextKey, bestKey);
      cameFrom.points.set(nextKey, next);
      scores.set(nextKey, tentativeScore);
      estimate.set(nextKey, tentativeScore + heuristic(next, goal));

      if (!queued.has(nextKey)) {
        open.push(next);
        queued.add(nextKey);
      }
    }
  }

  return [gridToPixel(start), gridToPixel(goal)];
}

self.addEventListener('message', (event) => {
  const {id, type, payload} = event.data;

  try {
    if (type === 'init') {
      settings = {...settings, ...(payload.options || {})};
      postSuccess(id, {ready: true});
      return;
    }

    if (type === 'analyzeImage') {
      model = buildGradientModel(payload);
      anchorPoint = undefined;
      postSuccess(id, {ready: true});
      return;
    }

    if (type === 'buildMap') {
      if (!model) {
        throw new Error('No contour image is loaded.');
      }

      anchorPoint = [payload.x, payload.y];
      postSuccess(id, {ready: true});
      return;
    }

    if (type === 'getContour') {
      const points = findContourPath([payload.x, payload.y]);
      postSuccess(id, {points});
      return;
    }

    throw new Error(`Unknown worker request: ${type}`);
  } catch (error) {
    postFailure(id, error);
  }
});
