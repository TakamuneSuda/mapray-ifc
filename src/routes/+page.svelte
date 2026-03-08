<script lang="ts">
	import { base } from '$app/paths';
	import { onMount } from 'svelte';
	import { MaprayIfcController } from '$lib';
	import type { ExtractedModelStats, IfcElementMetadata } from '$lib';
	import {
		buildSampleIfcUrl,
		DEFAULT_SAMPLE_IFC_NAME,
		getSampleLoadErrorMessage
	} from './sample-ifc';

	type MaprayUiModule = typeof import('@mapray/ui').default;
	type StandardUIViewerInstance = InstanceType<MaprayUiModule['StandardUIViewer']>;
	type GeoPointLike = {
		longitude: number;
		latitude: number;
		height: number;
	};

	const ACCESS_TOKEN = import.meta.env.VITE_MAPRAY_ACCESS_TOKEN;
	const INITIAL_CAMERA_DISTANCE = 300;
	const DEFAULT_SAMPLE_IFC_URL = buildSampleIfcUrl(base, DEFAULT_SAMPLE_IFC_NAME);

	let mapContainer: HTMLDivElement;
	let fileInput: HTMLInputElement;
	let stdViewer: StandardUIViewerInstance | null = null;
	let ifcController: MaprayIfcController | null = null;

	let loading = false;
	let initializing = true;
	let statusMessage = 'Mapray viewer initializing...';
	let errorMessage = '';
	let selectedFileName = '';
	let modelStats: ExtractedModelStats | null = null;
	let selectedElement: IfcElementMetadata | null = null;
	let loadedEntityCount = 0;

	let longitude = 139.58417387313645;
	let latitude = 35.862773784383755;
	let height = 44;
	let heading = 0;
	let tilt = 0;
	let roll = 0;
	let scale = 1;

	function getInitialCameraView(target: GeoPointLike) {
		const latitudeOffset = INITIAL_CAMERA_DISTANCE / 111_320;

		return {
			camera_position: {
				longitude: target.longitude,
				latitude: target.latitude - latitudeOffset,
				height: target.height + INITIAL_CAMERA_DISTANCE
			},
			lookat_position: {
				longitude: target.longitude,
				latitude: target.latitude,
				height: target.height
			}
		};
	}

	function clearLoadedModel(): void {
		ifcController?.unload();
		selectedElement = null;
		modelStats = null;
		loadedEntityCount = 0;
		statusMessage = stdViewer ? 'IFC file is not loaded.' : statusMessage;
	}

	function applyCurrentTransform(updateStatus = false): void {
		if (!ifcController || loadedEntityCount === 0) {
			return;
		}

		ifcController.setTransform({
			longitude,
			latitude,
			height,
			heading,
			tilt,
			roll,
			scale
		});

		if (updateStatus) {
			statusMessage = `Transform applied: ${longitude.toFixed(6)}, ${latitude.toFixed(6)}, ${height.toFixed(1)} m.`;
		}
	}

	function handleApplyTransform(): void {
		errorMessage = '';
		applyCurrentTransform(true);
	}

	function handleMapClick(event: MouseEvent): void {
		if (!stdViewer || !ifcController || loadedEntityCount === 0) {
			return;
		}

		const canvas = stdViewer.viewer.canvas_element;
		const rect = canvas.getBoundingClientRect();
		const result = ifcController.pick([event.clientX - rect.left, event.clientY - rect.top]);
		selectedElement = result.element;
	}

	function summarizeField(
		label: string,
		value: string | null | undefined
	): { label: string; value: string } | null {
		if (!value) {
			return null;
		}

		return { label, value };
	}

	function getSelectedSummary(element: IfcElementMetadata): { label: string; value: string }[] {
		return [
			summarizeField('Type', element.type),
			summarizeField('Express ID', String(element.expressID)),
			summarizeField('Global ID', element.globalId),
			summarizeField('Name', element.name),
			summarizeField('Description', element.description),
			summarizeField('Object Type', element.objectType),
			summarizeField('Tag', element.tag),
			summarizeField('Predefined Type', element.predefinedType)
		].filter((entry): entry is { label: string; value: string } => entry !== null);
	}

	async function loadIfcSource(
		source: File | Blob | ArrayBuffer,
		fileName: string,
		fileSizeBytes?: number
	): Promise<void> {
		if (!ifcController) {
			errorMessage = 'Mapray IFC controller is not ready.';
			return;
		}

		loading = true;
		errorMessage = '';
		selectedFileName = fileName;
		selectedElement = null;
		statusMessage = 'Reading IFC file...';

		try {
			const result = await ifcController.load(source, { fileSizeBytes });
			modelStats = result.stats;
			loadedEntityCount = result.loadedEntityCount;
			applyCurrentTransform(false);
			statusMessage = `Loaded ${result.stats.elementCount.toLocaleString()} elements in ${result.chunkCount.toLocaleString()} chunks / ${result.stats.triangleCount.toLocaleString()} triangles. Click an element to inspect attributes.`;
		} catch (error) {
			clearLoadedModel();
			errorMessage = error instanceof Error ? error.message : 'IFCの読み込みに失敗しました。';
			statusMessage = 'IFC load failed.';
		} finally {
			loading = false;
		}
	}

	async function handleLoad(): Promise<void> {
		const file = fileInput?.files?.[0];

		if (!file) {
			errorMessage = 'IFC fileを選択してください。';
			return;
		}

		await loadIfcSource(file, file.name, file.size);
	}

	async function loadDefaultSample(): Promise<void> {
		const response = await fetch(DEFAULT_SAMPLE_IFC_URL);

		if (!response.ok) {
			throw new Error(`Failed to fetch sample IFC: ${response.status} ${response.statusText}`);
		}

		const blob = await response.blob();
		await loadIfcSource(blob, DEFAULT_SAMPLE_IFC_NAME, blob.size);
	}

	function handleRemove(): void {
		errorMessage = '';
		clearLoadedModel();
	}

	function handleFileChange(event: Event): void {
		const target = event.currentTarget as HTMLInputElement;
		selectedFileName = target.files?.[0]?.name ?? '';
	}

	onMount(() => {
		let active = true;
		let canvas: HTMLCanvasElement | null = null;

		void (async () => {
			try {
				if (!ACCESS_TOKEN) {
					throw new Error('VITE_MAPRAY_ACCESS_TOKEN is not set.');
				}

				const [{ default: mapray }, { default: maprayui }] = await Promise.all([
					import('@mapray/mapray-js'),
					import('@mapray/ui')
				]);

				if (!active) {
					return;
				}

				stdViewer = new maprayui.StandardUIViewer(
					mapContainer,
					ACCESS_TOKEN,
					getInitialCameraView({
						longitude,
						latitude,
						height
					})
				);
				ifcController = new MaprayIfcController({
					mapray,
					viewer: stdViewer.viewer,
					onProgress: (message) => {
						statusMessage = message;
					}
				});
				canvas = stdViewer.viewer.canvas_element;
				canvas.addEventListener('click', handleMapClick);
			} catch (error) {
				errorMessage = error instanceof Error ? error.message : 'Viewer initialization failed.';
				statusMessage = 'Viewer initialization failed.';
				return;
			}

			try {
				statusMessage = 'Loading sample IFC...';
				await loadDefaultSample();
			} catch (error) {
				errorMessage = getSampleLoadErrorMessage(error);
				statusMessage = 'Sample IFC auto-load failed. You can still load another IFC file.';
			} finally {
				if (active) {
					initializing = false;
				}
			}
		})();

		return () => {
			active = false;
			canvas?.removeEventListener('click', handleMapClick);
			ifcController?.destroy();
			ifcController = null;
			stdViewer?.destroy();
			stdViewer = null;
		};
	});
</script>

<svelte:head>
	<title>mapray-ifc</title>
</svelte:head>

<div class="relative h-screen w-screen overflow-hidden bg-slate-950 text-slate-50">
	<div bind:this={mapContainer} class="h-full w-full"></div>

	<div
		class="absolute top-4 left-4 z-10 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-4 rounded-2xl border border-white/15 bg-slate-900/85 p-4 shadow-2xl backdrop-blur"
	>
		<div class="space-y-1">
			<p class="text-xs tracking-[0.3em] text-cyan-300 uppercase">Mapray IFC</p>
			<h1 class="text-2xl font-semibold">controller demo</h1>
			<p class="text-sm text-slate-300">
				`MaprayIfcController` を使って IFC を追加する最小 UI です。
			</p>
		</div>

		<div class="space-y-2">
			<label class="block text-sm font-medium text-slate-200" for="ifc-file">IFC File</label>
			<input
				id="ifc-file"
				bind:this={fileInput}
				class="block w-full cursor-pointer rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 file:mr-3 file:rounded-lg file:border-0 file:bg-cyan-400 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-950"
				type="file"
				accept=".ifc"
				disabled={loading || initializing}
				on:change={handleFileChange}
			/>
			{#if selectedFileName}
				<p class="text-xs text-slate-400">{selectedFileName}</p>
			{/if}
		</div>

		<div class="grid grid-cols-2 gap-3 text-sm">
			<label class="space-y-1">
				<span class="block text-slate-300">Longitude</span>
				<input
					bind:value={longitude}
					class="w-full rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2"
					type="number"
					step="0.000001"
				/>
			</label>
			<label class="space-y-1">
				<span class="block text-slate-300">Latitude</span>
				<input
					bind:value={latitude}
					class="w-full rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2"
					type="number"
					step="0.000001"
				/>
			</label>
			<label class="space-y-1">
				<span class="block text-slate-300">Height</span>
				<input
					bind:value={height}
					class="w-full rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2"
					type="number"
					step="1"
				/>
			</label>
			<label class="space-y-1">
				<span class="block text-slate-300">Scale</span>
				<input
					bind:value={scale}
					class="w-full rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2"
					type="number"
					min="0.01"
					step="0.1"
				/>
			</label>
			<label class="space-y-1">
				<span class="block text-slate-300">Heading</span>
				<input
					bind:value={heading}
					class="w-full rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2"
					type="number"
					step="1"
				/>
			</label>
			<label class="space-y-1">
				<span class="block text-slate-300">Tilt</span>
				<input
					bind:value={tilt}
					class="w-full rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2"
					type="number"
					step="1"
				/>
			</label>
			<label class="space-y-1">
				<span class="block text-slate-300">Roll</span>
				<input
					bind:value={roll}
					class="w-full rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2"
					type="number"
					step="1"
				/>
			</label>
		</div>

		<div class="flex flex-wrap gap-2">
			<button
				class="rounded-xl bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
				disabled={loading || initializing}
				on:click={handleLoad}
			>
				{loading ? 'Loading...' : 'Load IFC'}
			</button>
			<button
				class="rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm font-medium text-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
				disabled={loadedEntityCount === 0 || loading}
				on:click={handleApplyTransform}
			>
				Apply Transform
			</button>
			<button
				class="rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm font-medium text-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
				disabled={loadedEntityCount === 0 || loading}
				on:click={handleRemove}
			>
				Remove
			</button>
		</div>

		<div class="space-y-2 rounded-xl border border-white/10 bg-black/20 p-3 text-sm">
			<p class="text-slate-200">{statusMessage}</p>
			{#if errorMessage}
				<p class="text-rose-300">{errorMessage}</p>
			{/if}
			<p class="text-xs text-slate-400">座標や姿勢を変更したら `Apply Transform` で反映します。</p>
			{#if modelStats}
				<div class="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-300">
					<p>Elements: {modelStats.elementCount.toLocaleString()}</p>
					<p>Entities: {loadedEntityCount.toLocaleString()}</p>
					<p>Meshes: {modelStats.meshCount.toLocaleString()}</p>
					<p>Vertices: {modelStats.vertexCount.toLocaleString()}</p>
					<p>Triangles: {modelStats.triangleCount.toLocaleString()}</p>
					<p class="col-span-2">
						Size:
						{modelStats.bounds.size.map((value) => value.toFixed(1)).join(' x ')} m
					</p>
				</div>
			{/if}
		</div>
	</div>

	<div
		class="absolute top-4 right-4 bottom-4 z-10 flex w-[28rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-white/15 bg-slate-900/85 shadow-2xl backdrop-blur"
	>
		<div class="border-b border-white/10 px-4 py-3">
			<p class="text-xs tracking-[0.3em] text-amber-300 uppercase">Attributes</p>
			<h2 class="text-lg font-semibold">Selected IFC Element</h2>
		</div>

		<div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
			{#if !modelStats}
				<p class="text-sm text-slate-400">
					IFC を読み込むと、クリックした要素の属性をここに表示します。
				</p>
			{:else if !selectedElement}
				<p class="text-sm text-slate-400">地図上の IFC 要素をクリックしてください。</p>
			{:else}
				<div class="space-y-5">
					<div class="space-y-2">
						<p class="text-sm font-semibold text-slate-100">
							{selectedElement.name ?? selectedElement.type}
						</p>

						<div class="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
							{#each getSelectedSummary(selectedElement) as field (field.label)}
								<p class="text-slate-400">{field.label}</p>
								<p class="break-all text-slate-100">{field.value}</p>
							{/each}
						</div>
					</div>

					<div class="space-y-3">
						<h3 class="text-sm font-semibold text-slate-200">Property Sets</h3>

						{#if selectedElement.propertyGroups.length === 0}
							<p class="text-sm text-slate-400">Property Set は見つかりませんでした。</p>
						{:else}
							{#each selectedElement.propertyGroups as group, groupIndex (`${group.name}-${groupIndex}`)}
								<section class="rounded-xl border border-white/10 bg-black/20 p-3">
									<h4 class="mb-3 text-sm font-medium text-cyan-200">{group.name}</h4>

									<div class="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-2 text-xs">
										{#each group.properties as property, propertyIndex (`${property.name}-${propertyIndex}`)}
											<p class="break-words text-slate-400">{property.name}</p>
											<p class="break-words text-slate-100">{property.value}</p>
										{/each}
									</div>
								</section>
							{/each}
						{/if}
					</div>
				</div>
			{/if}
		</div>
	</div>
</div>
