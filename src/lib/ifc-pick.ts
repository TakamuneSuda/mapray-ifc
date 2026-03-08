import type { IfcElementBounds, IfcElementMetadata } from './ifc-loader';

type Vector3 = [number, number, number];

export function isPointInsideBounds(
	point: Vector3,
	bounds: IfcElementBounds,
	epsilon: number
): boolean {
	return (
		point[0] >= bounds.min[0] - epsilon &&
		point[0] <= bounds.max[0] + epsilon &&
		point[1] >= bounds.min[1] - epsilon &&
		point[1] <= bounds.max[1] + epsilon &&
		point[2] >= bounds.min[2] - epsilon &&
		point[2] <= bounds.max[2] + epsilon
	);
}

export function getBoundsDistanceSquared(point: Vector3, bounds: IfcElementBounds): number {
	const dx =
		point[0] < bounds.min[0]
			? bounds.min[0] - point[0]
			: point[0] > bounds.max[0]
				? point[0] - bounds.max[0]
				: 0;
	const dy =
		point[1] < bounds.min[1]
			? bounds.min[1] - point[1]
			: point[1] > bounds.max[1]
				? point[1] - bounds.max[1]
				: 0;
	const dz =
		point[2] < bounds.min[2]
			? bounds.min[2] - point[2]
			: point[2] > bounds.max[2]
				? point[2] - bounds.max[2]
				: 0;

	return dx * dx + dy * dy + dz * dz;
}

export function getCenterDistanceSquared(point: Vector3, bounds: IfcElementBounds): number {
	const dx = point[0] - bounds.center[0];
	const dy = point[1] - bounds.center[1];
	const dz = point[2] - bounds.center[2];

	return dx * dx + dy * dy + dz * dz;
}

export function resolvePickedElement(
	candidates: IfcElementMetadata[],
	localPoint: Vector3,
	boundsEpsilon: number
): IfcElementMetadata | null {
	const withBounds = candidates.filter(
		(element): element is IfcElementMetadata & { bounds: IfcElementBounds } =>
			element.bounds !== null
	);

	if (withBounds.length === 0) {
		return null;
	}

	const containing = withBounds.filter((element) =>
		isPointInsideBounds(localPoint, element.bounds, boundsEpsilon)
	);

	if (containing.length > 0) {
		containing.sort((a, b) => {
			if (a.bounds.volume !== b.bounds.volume) {
				return a.bounds.volume - b.bounds.volume;
			}

			return (
				getCenterDistanceSquared(localPoint, a.bounds) -
				getCenterDistanceSquared(localPoint, b.bounds)
			);
		});

		return containing[0];
	}

	let nearest: (IfcElementMetadata & { bounds: IfcElementBounds }) | null = null;
	let nearestDistance = Number.POSITIVE_INFINITY;

	for (const element of withBounds) {
		const distance = getBoundsDistanceSquared(localPoint, element.bounds);

		if (distance < nearestDistance) {
			nearest = element;
			nearestDistance = distance;
		}
	}

	return nearest;
}
