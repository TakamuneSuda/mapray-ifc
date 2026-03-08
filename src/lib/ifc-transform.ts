type MaprayModule = typeof import('@mapray/mapray-js').default;
type MaprayModelEntityInstance = InstanceType<MaprayModule['ModelEntity']>;
type Matrix = ReturnType<MaprayModule['GeoMath']['createMatrix']>;
type Vector3 = [number, number, number];

type IfcTransformLike = {
	longitude: number;
	latitude: number;
	height: number;
	heading: number;
	tilt: number;
	roll: number;
	scale: number;
};

export function getCurrentOriginGocs(
	mapray: MaprayModule,
	transform: IfcTransformLike
): Vector3 {
	const origin = new mapray.GeoPoint(
		transform.longitude,
		transform.latitude,
		transform.height
	).getAsGocs(mapray.GeoMath.createVector3());

	return [origin[0], origin[1], origin[2]];
}

export function getTransformFromGocsPosition(
	mapray: MaprayModule,
	position: Vector3
): Pick<IfcTransformLike, 'longitude' | 'latitude' | 'height'> {
	const geoPoint = new mapray.GeoPoint().setFromGocs(position);

	return {
		longitude: geoPoint.longitude,
		latitude: geoPoint.latitude,
		height: geoPoint.altitude
	};
}

export function applyTransformToEntities(
	mapray: MaprayModule,
	entities: MaprayModelEntityInstance[],
	transform: IfcTransformLike
): void {
	if (entities.length === 0) {
		return;
	}

	const position = new mapray.GeoPoint(
		transform.longitude,
		transform.latitude,
		transform.height
	);
	const orientation = new mapray.Orientation(
		transform.heading,
		transform.tilt,
		transform.roll
	);

	for (const entity of entities) {
		entity.setPosition(position);
		entity.setOrientation(orientation);
		entity.setScale([transform.scale, transform.scale, transform.scale]);
		entity.altitude_mode = mapray.AltitudeMode.ABSOLUTE;
	}
}

export function getModelToGocsMatrix(
	mapray: MaprayModule,
	transform: IfcTransformLike,
	modelOffsetTilt: number
): Matrix {
	const geoMath = mapray.GeoMath;
	const mlocsToGocs = new mapray.GeoPoint(
		transform.longitude,
		transform.latitude,
		transform.height
	).getMlocsToGocsMatrix(geoMath.createMatrix());
	const entityToMlocs = new mapray.Orientation(
		transform.heading,
		transform.tilt,
		transform.roll
	).getTransformMatrix(
		[transform.scale, transform.scale, transform.scale],
		geoMath.createMatrix()
	);
	const offsetToEntity = new mapray.Orientation(0, modelOffsetTilt, 0).getTransformMatrix(
		[1, 1, 1],
		geoMath.createMatrix()
	);
	const modelToMlocs = geoMath.mul_AA(entityToMlocs, offsetToEntity, geoMath.createMatrix());

	return geoMath.mul_AA(mlocsToGocs, modelToMlocs, geoMath.createMatrix());
}

export function toModelLocalPosition(
	mapray: MaprayModule,
	transform: IfcTransformLike,
	modelOffsetTilt: number,
	position: Vector3
): Vector3 {
	const geoMath = mapray.GeoMath;
	const modelToGocs = getModelToGocsMatrix(mapray, transform, modelOffsetTilt);
	const gocsToModel = geoMath.inverse_A(modelToGocs, geoMath.createMatrix());
	const localPosition = geoMath.transformPosition_A(
		gocsToModel,
		position,
		geoMath.createVector3()
	);

	return [localPosition[0], localPosition[1], localPosition[2]];
}
