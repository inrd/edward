let settings = {
  gridStep: 2,
  searchPadding: 52,
  maxSearchPadding: 136,
  edgeBias: 8,
  lineBias: 1.35,
  turnBias: 1.1,
  continuityBias: 1.35,
  guideBias: 0.3,
  simplifyTolerance: 1.15,
  simplifyMaxDeviation: 2.4,
  simplifyGradientBias: 0.4
};

let model;
let anchorPoint;
const NEIGHBOR_STEPS = [
  [-1, -1, Math.SQRT2], [0, -1, 1], [1, -1, Math.SQRT2],
  [-1, 0, 1],                           [1, 0, 1],
  [-1, 1, Math.SQRT2],  [0, 1, 1],  [1, 1, Math.SQRT2]
];

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

function buildLineDistanceEvaluator(start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];

  if (dx === 0 && dy === 0) {
    return (x, y) => Math.hypot(x - start[0], y - start[1]);
  }

  const intercept = end[0] * start[1] - end[1] * start[0];
  const inverseDenominator = 1 / Math.hypot(dx, dy);

  return (x, y) => Math.abs(dy * x - dx * y + intercept) * inverseDenominator;
}

function pointToSegmentDistance(x, y, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return Math.hypot(x - start[0], y - start[1]);
  }

  const t = clamp(((x - start[0]) * dx + (y - start[1]) * dy) / lengthSquared, 0, 1);
  const projectionX = start[0] + t * dx;
  const projectionY = start[1] + t * dy;
  return Math.hypot(x - projectionX, y - projectionY);
}

function buildGuideDistanceEvaluator(points) {
  if (!points || points.length < 2) {
    return () => 0;
  }

  const guidePoints = points.map(pixelToGrid);
  return (x, y) => {
    let minDistance = Number.POSITIVE_INFINITY;

    for (let index = 1; index < guidePoints.length; index += 1) {
      const distance = pointToSegmentDistance(x, y, guidePoints[index - 1], guidePoints[index]);
      if (distance < minDistance) {
        minDistance = distance;
      }
    }

    return Number.isFinite(minDistance) ? minDistance : 0;
  };
}

function getTurnCost(parentIndex, currentX, currentY, nextX, nextY, gridWidth) {
  if (parentIndex === -1) {
    return 0;
  }

  const parentX = parentIndex % gridWidth;
  const parentY = Math.floor(parentIndex / gridWidth);
  const previousDx = currentX - parentX;
  const previousDy = currentY - parentY;
  const nextDx = nextX - currentX;
  const nextDy = nextY - currentY;
  const previousLength = Math.hypot(previousDx, previousDy);
  const nextLength = Math.hypot(nextDx, nextDy);

  if (previousLength === 0 || nextLength === 0) {
    return 0;
  }

  const cosine = clamp(
    (previousDx * nextDx + previousDy * nextDy) / (previousLength * nextLength),
    -1,
    1
  );

  return (1 - cosine) * settings.turnBias;
}

function getDirectionCost(direction, expectedDirection) {
  if (!expectedDirection) {
    return 0;
  }

  const length = Math.hypot(direction[0], direction[1]);
  const expectedLength = Math.hypot(expectedDirection[0], expectedDirection[1]);
  if (length === 0 || expectedLength === 0) {
    return 0;
  }

  const cosine = clamp(
    (direction[0] * expectedDirection[0] + direction[1] * expectedDirection[1]) / (length * expectedLength),
    -1,
    1
  );

  return (1 - cosine) * settings.continuityBias;
}

function createMinHeap() {
  const nodes = [];

  function bubbleUp(index) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (nodes[parent].score <= nodes[index].score) {
        break;
      }

      [nodes[parent], nodes[index]] = [nodes[index], nodes[parent]];
      index = parent;
    }
  }

  function bubbleDown(index) {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;

      if (left < nodes.length && nodes[left].score < nodes[smallest].score) {
        smallest = left;
      }

      if (right < nodes.length && nodes[right].score < nodes[smallest].score) {
        smallest = right;
      }

      if (smallest === index) {
        break;
      }

      [nodes[index], nodes[smallest]] = [nodes[smallest], nodes[index]];
      index = smallest;
    }
  }

  return {
    get size() {
      return nodes.length;
    },
    push(node) {
      nodes.push(node);
      bubbleUp(nodes.length - 1);
    },
    pop() {
      if (nodes.length === 0) {
        return undefined;
      }

      const top = nodes[0];
      const tail = nodes.pop();
      if (nodes.length > 0 && tail) {
        nodes[0] = tail;
        bubbleDown(0);
      }

      return top;
    }
  };
}

function reconstructPath(parent, goalIndex) {
  const path = [];
  const width = model.gridWidth;
  let index = goalIndex;

  while (index !== -1) {
    const x = index % width;
    const y = Math.floor(index / width);
    path.push([x, y]);
    index = parent[index];
  }

  path.reverse();
  return path;
}

function removeLowValuePoints(points) {
  let nextPoints = points;
  let changed = nextPoints.length >= 3;

  while (changed && nextPoints.length >= 3) {
    changed = false;
    const simplified = [nextPoints[0]];

    for (let index = 1; index < nextPoints.length - 1; index += 1) {
      const previous = simplified[simplified.length - 1];
      const current = nextPoints[index];
      const next = nextPoints[index + 1];
      const inDx = current[0] - previous[0];
      const inDy = current[1] - previous[1];
      const outDx = next[0] - current[0];
      const outDy = next[1] - current[1];
      const inLength = Math.hypot(inDx, inDy);
      const outLength = Math.hypot(outDx, outDy);

      if (inLength === 0 || outLength === 0) {
        changed = true;
        continue;
      }

      const cosine = clamp((inDx * outDx + inDy * outDy) / (inLength * outLength), -1, 1);
      const shortcutLength = Math.hypot(next[0] - previous[0], next[1] - previous[1]);
      const detourCost = inLength + outLength - shortcutLength;
      const localGradient = gradientAt(current[0], current[1]);

      if (cosine < 0.6 && detourCost < 1.6 && localGradient < 0.4) {
        changed = true;
        continue;
      }

      simplified.push(current);
    }

    simplified.push(nextPoints[nextPoints.length - 1]);
    nextPoints = simplified;
  }

  return nextPoints;
}

function getMaxSegmentDeviation(points, startIndex, endIndex) {
  const start = points[startIndex];
  const end = points[endIndex];
  let maxDeviation = 0;

  for (let index = startIndex + 1; index < endIndex; index += 1) {
    const point = points[index];
    const deviation = pointToSegmentDistance(point[0], point[1], start, end);
    if (deviation > maxDeviation) {
      maxDeviation = deviation;
    }
  }

  return maxDeviation;
}

function simplifyPath(points) {
  if (points.length <= 2) {
    return points.map(gridToPixel);
  }

  const cleanedPoints = removeLowValuePoints(points);
  if (cleanedPoints.length <= 2) {
    return cleanedPoints.map(gridToPixel);
  }

  const keep = new Uint8Array(cleanedPoints.length);
  const stack = [[0, cleanedPoints.length - 1]];
  keep[0] = 1;
  keep[cleanedPoints.length - 1] = 1;

  while (stack.length > 0) {
    const [startIndex, endIndex] = stack.pop();
    if (endIndex - startIndex < 2) {
      continue;
    }

    const start = cleanedPoints[startIndex];
    const end = cleanedPoints[endIndex];
    let splitIndex = -1;
    let maxScore = -1;
    let maxDeviation = 0;

    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const point = cleanedPoints[index];
      const deviation = pointToSegmentDistance(point[0], point[1], start, end);
      const gradientBias = gradientAt(point[0], point[1]) * settings.simplifyGradientBias;
      const score = deviation + gradientBias;

      if (score > maxScore) {
        splitIndex = index;
        maxScore = score;
        maxDeviation = deviation;
      }
    }

    if (splitIndex === -1) {
      continue;
    }

    if (maxScore > settings.simplifyTolerance) {
      keep[splitIndex] = 1;
      stack.push([startIndex, splitIndex], [splitIndex, endIndex]);
      continue;
    }

    const segmentDeviation = getMaxSegmentDeviation(cleanedPoints, startIndex, endIndex);
    if (segmentDeviation > settings.simplifyMaxDeviation) {
      keep[splitIndex] = 1;
      stack.push([startIndex, splitIndex], [splitIndex, endIndex]);
    }
  }

  const path = [];
  for (let index = 0; index < cleanedPoints.length; index += 1) {
    if (keep[index]) {
      path.push(gridToPixel(cleanedPoints[index]));
    }
  }

  return path;
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

function findContourPath(targetPixel, continuity = {}, guidePoints) {
  if (!model || !anchorPoint) {
    throw new Error('Contour model is not ready.');
  }

  const start = pixelToGrid(anchorPoint);
  const goal = pixelToGrid(targetPixel);
  const bounds = buildSearchBounds(start, goal);
  const gridWidth = model.gridWidth;
  const gridSize = gridWidth * model.gridHeight;
  const startIndex = start[1] * gridWidth + start[0];
  const goalIndex = goal[1] * gridWidth + goal[0];
  const heap = createMinHeap();
  const scores = new Float32Array(gridSize);
  const parent = new Int32Array(gridSize);
  const closed = new Uint8Array(gridSize);
  const distanceFromPathLine = buildLineDistanceEvaluator(start, goal);
  const distanceFromGuidePath = buildGuideDistanceEvaluator(guidePoints);
  const iterationLimit = Math.max(6000, (bounds.maxX - bounds.minX + 1) * (bounds.maxY - bounds.minY + 1) * 2);
  let iterations = 0;

  scores.fill(Number.POSITIVE_INFINITY);
  parent.fill(-1);
  scores[startIndex] = 0;
  heap.push({index: startIndex, score: heuristic(start, goal)});

  while (heap.size > 0 && iterations < iterationLimit) {
    iterations += 1;

    const currentNode = heap.pop();
    if (!currentNode) {
      break;
    }

    const currentIndex = currentNode.index;
    if (closed[currentIndex]) {
      continue;
    }

    if (currentIndex === goalIndex) {
      return simplifyPath(reconstructPath(parent, currentIndex));
    }

    closed[currentIndex] = 1;

    const currentX = currentIndex % gridWidth;
    const currentY = Math.floor(currentIndex / gridWidth);
    const currentScore = scores[currentIndex];

    for (const [dx, dy, movementCost] of NEIGHBOR_STEPS) {
      const nextX = currentX + dx;
      const nextY = currentY + dy;

      if (
        nextX < bounds.minX || nextX > bounds.maxX ||
        nextY < bounds.minY || nextY > bounds.maxY
      ) {
        continue;
      }

      const nextIndex = nextY * gridWidth + nextX;
      if (closed[nextIndex]) {
        continue;
      }

      const edgeStrength = gradientAt(nextX, nextY);
      const edgeCost = (1 - edgeStrength) * settings.edgeBias;
      const lineCost = distanceFromPathLine(nextX, nextY) * settings.lineBias * 0.08;
      const guideCost = distanceFromGuidePath(nextX, nextY) * settings.guideBias * 0.06;
      const turnCost = getTurnCost(parent[currentIndex], currentX, currentY, nextX, nextY, gridWidth);
      const stepDirection = [nextX - currentX, nextY - currentY];
      const startContinuityCost = currentIndex === startIndex
        ? getDirectionCost(stepDirection, continuity.startDirection)
        : 0;
      const endContinuityCost = nextIndex === goalIndex
        ? getDirectionCost(stepDirection, continuity.endDirection)
        : 0;
      const tentativeScore =
        currentScore + movementCost + edgeCost + lineCost + guideCost + turnCost + startContinuityCost + endContinuityCost;

      if (tentativeScore >= scores[nextIndex]) {
        continue;
      }

      parent[nextIndex] = currentIndex;
      scores[nextIndex] = tentativeScore;
      heap.push({
        index: nextIndex,
        score: tentativeScore + Math.hypot(nextX - goal[0], nextY - goal[1])
      });
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
      const points = findContourPath([payload.x, payload.y], payload.continuity, payload.guidePoints);
      postSuccess(id, {points});
      return;
    }

    throw new Error(`Unknown worker request: ${type}`);
  } catch (error) {
    postFailure(id, error);
  }
});
