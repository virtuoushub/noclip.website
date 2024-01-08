import * as Viewer from '../viewer.js';
import { SceneContext } from '../SceneBase.js';
import { rust } from '../rustlib.js';
import { WowM2, WowSkin, WowBlp, WowPixelFormat, WowWdt, WowAdt, WowAdtChunkDescriptor, WowDoodad, WowSkinSubmesh, WowModelBatch, WowAdtWmoDefinition } from '../../rust/pkg/index.js';
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper.js';
import { DeviceProgram } from '../Program.js';
import { GfxDevice, GfxVertexAttributeDescriptor, GfxInputLayoutBufferDescriptor, GfxVertexBufferFrequency, GfxBufferUsage, GfxVertexBufferDescriptor, GfxBindingLayoutDescriptor, GfxCullMode, GfxIndexBufferDescriptor, makeTextureDescriptor2D, GfxMipFilterMode, GfxTexFilterMode, GfxWrapMode, GfxTextureDimension, GfxTextureUsage, GfxInputLayoutDescriptor, GfxClipSpaceNearZ } from '../gfx/platform/GfxPlatform.js';
import { GfxFormat } from '../gfx/platform/GfxPlatformFormat.js';
import { GfxBuffer, GfxInputLayout, GfxProgram } from '../gfx/platform/GfxPlatformImpl.js';
import { GfxRenderInst, GfxRenderInstList, GfxRenderInstManager } from '../gfx/render/GfxRenderInstManager.js';
import { makeStaticDataBuffer } from '../gfx/helpers/BufferHelpers.js';
import { makeBackbufferDescSimple, standardFullClearRenderPassDescriptor, pushAntialiasingPostProcessPass } from '../gfx/helpers/RenderGraphHelpers.js';
import { GfxrAttachmentSlot } from '../gfx/render/GfxRenderGraph.js';
import { fillMatrix4x4, fillVec4, fillVec4v } from '../gfx/helpers/UniformBufferHelpers.js';
import { DataFetcher, NamedArrayBufferSlice } from '../DataFetcher.js';
import { assert, nArray } from '../util.js';
import { TextureCache } from './tex.js';
import { TextureMapping } from '../TextureHolder.js';
import { mat3, mat4, vec3, vec4 } from 'gl-matrix';
import { ModelData, SkinData, AdtData, WorldData, DoodadData, WmoData, WmoBatchData, WmoDefinition, LazyWorldData, WowCache, Database, WmoGroupData, LiquidType, AdtCoord, PortalData } from './data.js';
import { getMatrixTranslation, lerp, projectionMatrixForFrustum } from "../MathHelpers.js";
import { fetchFileByID, fetchDataByFileID, initSheepfile } from "./util.js";
import { CameraController, computeViewSpaceDepthFromWorldSpaceAABB } from '../Camera.js';
import { TextureListHolder, Panel } from '../ui.js';
import { GfxTopology, convertToTriangleIndexBuffer } from '../gfx/helpers/TopologyHelpers.js';
import { drawWorldSpaceAABB, drawWorldSpaceLine, drawWorldSpacePoint, drawWorldSpaceText, drawWorldSpaceVector, getDebugOverlayCanvas2D, interactiveVizSliderSelect } from '../DebugJunk.js';
import { Frustum, AABB, Plane, IntersectionState } from '../Geometry.js';
import { ModelProgram, MAX_DOODAD_INSTANCES, WmoProgram, TerrainProgram, SkyboxProgram, BaseProgram, WaterProgram, LoadingAdtProgram, DebugWmoPortalProgram } from './program.js';
import { ViewerRenderInput } from '../viewer.js';
import { skyboxIndices, skyboxVertices } from './mesh.js';
import { DebugWmoPortalRenderer, LoadingAdtRenderer, ModelRenderer, SkyboxRenderer, TerrainRenderer, WaterRenderer, WmoRenderer } from './render.js';
import { Water } from '../Glover/parsers/GloverLevel.cjs';
import { Color, colorNewFromRGBA } from '../Color.js';

export const MAP_SIZE = 17066;

export const noclipSpaceFromAdtSpace = mat4.fromValues(
  0, 0, -1, 0,
  -1, 0, 0, 0,
  0, 1, 0, 0,
  MAP_SIZE, 0, MAP_SIZE, 1,
);
export const placementSpaceFromAdtSpace = noclipSpaceFromAdtSpace;

export const noclipSpaceFromModelSpace = mat4.fromValues(
  0, 0, 1, 0,
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 0, 1,
);

export const noclipSpaceFromPlacementSpace = mat4.fromValues(
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
)

export const adtSpaceFromPlacementSpace: mat4 = mat4.invert(mat4.create(), noclipSpaceFromAdtSpace);
mat4.mul(adtSpaceFromPlacementSpace, adtSpaceFromPlacementSpace, noclipSpaceFromPlacementSpace);

export const adtSpaceFromModelSpace: mat4 = mat4.invert(mat4.create(), noclipSpaceFromAdtSpace);
mat4.mul(adtSpaceFromModelSpace, adtSpaceFromModelSpace, noclipSpaceFromModelSpace);

export const placementSpaceFromModelSpace: mat4 = mat4.invert(mat4.create(), noclipSpaceFromPlacementSpace);
mat4.mul(placementSpaceFromModelSpace, placementSpaceFromModelSpace, noclipSpaceFromModelSpace);

export const modelSpaceFromAdtSpace: mat4 = mat4.invert(mat4.create(), adtSpaceFromModelSpace);
export const modelSpaceFromPlacementSpace: mat4 = mat4.invert(mat4.create(), placementSpaceFromModelSpace);


const scratchVec3 = vec3.create();
export class View {
    // aka viewMatrix
    public viewFromWorldMatrix = mat4.create();
    // aka worldMatrix
    public worldFromViewMatrix = mat4.create();
    public clipFromWorldMatrix = mat4.create();
    // aka projectionMatrix
    public clipFromViewMatrix = mat4.create();
    public interiorSunDirection: vec4 = [-0.30822, -0.30822, -0.89999998, 0];
    public exteriorDirectColorDirection: vec4 = [-0.30822, -0.30822, -0.89999998, 0];
    public clipSpaceNearZ: GfxClipSpaceNearZ;
    public cameraPos = vec3.create();
    public frustum: Frustum = new Frustum();
    public time: number;
    public deltaTime: number;
    public farPlane = 1000;
    public timeOffset = 1440;
    public secondsPerGameDay = 90;

    public finishSetup(): void {
      mat4.invert(this.worldFromViewMatrix, this.viewFromWorldMatrix);
      mat4.mul(this.clipFromWorldMatrix, this.clipFromViewMatrix, this.viewFromWorldMatrix);
      getMatrixTranslation(this.cameraPos, this.worldFromViewMatrix);
      this.frustum.updateClipFrustum(this.clipFromWorldMatrix, this.clipSpaceNearZ);
    }

    private calculateSunDirection(): void {
      const theta = 3.926991;
      const phiMin = 2.2165682;
      const phiMax = 1.9198623;
      let timePct = (this.time % 1440.0) / 1440.0;
      let phi;
      if (timePct < 0.5) {
        phi = lerp(phiMax, phiMin, timePct / 0.5);
      } else {
        phi = lerp(phiMin, phiMax, (timePct - 0.5) / 0.5);
      }
      const sinPhi = Math.sin(phi);
      const cosPhi = Math.cos(phi);
      const sinTheta = Math.sin(theta);
      const cosTheta = Math.cos(theta);
      this.exteriorDirectColorDirection = [sinPhi * cosTheta, sinPhi * sinTheta, cosPhi, 0];
    }

    public cameraDistanceToWorldSpaceAABB(aabb: AABB): number {
      aabb.centerPoint(scratchVec3);
      return vec3.distance(this.cameraPos, scratchVec3);
    }

    public setupFromViewerInput(viewerInput: Viewer.ViewerRenderInput): void {
      this.clipSpaceNearZ = viewerInput.camera.clipSpaceNearZ;
      mat4.mul(this.viewFromWorldMatrix, viewerInput.camera.viewMatrix, noclipSpaceFromAdtSpace);
      projectionMatrixForFrustum(this.clipFromViewMatrix,
        viewerInput.camera.left,
        viewerInput.camera.right,
        viewerInput.camera.bottom,
        viewerInput.camera.top,
        viewerInput.camera.near,
        this.farPlane
      );
      this.time = (viewerInput.time / this.secondsPerGameDay + this.timeOffset) % 2880;
      this.deltaTime = viewerInput.deltaTime;
      this.calculateSunDirection();
      this.finishSetup();
    }
}

enum CullingState {
  Running,
  Paused,
  OneShot,
}

enum CameraState {
  Frozen,
  Running,
}

export class MapArray<K, V> {
  public map: Map<K, V[]> = new Map();

  constructor() {
  }

  public has(key: K): boolean {
    return this.map.has(key);
  }

  public get(key: K): V[] {
    const result = this.map.get(key);
    if (result === undefined) {
      return [];
    }
    return result;
  }

  public append(key: K, value: V) {
    if (this.map.has(key)) {
      this.map.get(key)!.push(value);
    } else {
      this.map.set(key, [value]);
    }
  }

  public extend(key: K, values: V[]) {
    if (this.map.has(key)) {
      this.map.set(key, this.map.get(key)!.concat(values));
    } else {
      this.map.set(key, values);
    }
  }

  public keys(): IterableIterator<K> {
    return this.map.keys();
  }

  public values(): IterableIterator<V[]> {
    return this.map.values();
  }
}

let drawPortalScratchVec3a = vec3.create();
let drawPortalScratchVec3b = vec3.create();
function drawDebugPortal(portal: PortalData, view: View, name: string, level: number) {
  const colors = [
    colorNewFromRGBA(1, 0, 0),
    colorNewFromRGBA(0, 1, 0),
    colorNewFromRGBA(0, 0, 1),
    colorNewFromRGBA(1, 1, 0),
    colorNewFromRGBA(0, 1, 1),
    colorNewFromRGBA(1, 1, 1),
  ];
  for (let i in portal.points) {
    const p = portal.points[i];
    drawWorldSpacePoint(getDebugOverlayCanvas2D(), view.clipFromWorldMatrix, p, colors[level], 10);
    drawWorldSpaceText(getDebugOverlayCanvas2D(), view.clipFromWorldMatrix, p, `${i}`);
  }
  // vec3.lerp(drawPortalScratchVec3a, portal.points[0], portal.points[1], 0.5);
  // vec3.lerp(drawPortalScratchVec3b, portal.points[2], portal.points[3], 0.5);
  // vec3.lerp(drawPortalScratchVec3a, drawPortalScratchVec3a, drawPortalScratchVec3b, 0.5);
  // drawWorldSpaceText(getDebugOverlayCanvas2D(), view.clipFromWorldMatrix, drawPortalScratchVec3a, name);
  // drawWorldSpaceAABB(getDebugOverlayCanvas2D(), view.clipFromWorldMatrix, portal.aabb);
  // drawDebugPlane(portal.plane, view, colors[level]);
}

function drawDebugPlane(plane: Plane, view: View, color: Color | undefined = undefined) {
  vec3.scale(drawPortalScratchVec3a, plane.n, plane.d);
  drawWorldSpacePoint(getDebugOverlayCanvas2D(), view.clipFromWorldMatrix, drawPortalScratchVec3a);
  drawWorldSpaceText(getDebugOverlayCanvas2D(), view.clipFromWorldMatrix, drawPortalScratchVec3a, 'plane');
  // drawWorldSpaceVector(getDebugOverlayCanvas2D(), view.clipFromWorldMatrix, drawFrustumScratchVec3a, plane.n, 10.0);
}

let drawFrustumScratchVec3a = vec3.create();
let drawFrustumScratchVec3b = vec3.create();
function drawDebugFrustum(f: Frustum, view: View, color: Color | undefined = undefined) {
  const near = f.planes[4];
  const far = f.planes[5];
  let planePairs = [
    [0, 2], // Left/Top
    [1, 2], // Right/Top
    [1, 3], // Right/Bottom
    [0, 3], // Left/Bottom
  ];
  for (let [p1, p2] of planePairs) {
    findIncidentPoint(drawFrustumScratchVec3a, f.planes[p1], f.planes[p2], near);
    findIncidentPoint(drawFrustumScratchVec3b, f.planes[p1], f.planes[p2], far);
    drawWorldSpaceLine(
      getDebugOverlayCanvas2D(),
      view.clipFromWorldMatrix,
      drawFrustumScratchVec3a,
      drawFrustumScratchVec3b,
      color
    );
  }
}

let incidentScratchMat = mat3.create();
let incidentScratchVec3 = vec3.create();
function findIncidentPoint(dst: vec3, p1: Plane, p2: Plane, p3: Plane) {
  incidentScratchMat[0] = p1.n[0];
  incidentScratchMat[1] = p2.n[0];
  incidentScratchMat[2] = p3.n[0];
  incidentScratchMat[3] = p1.n[1];
  incidentScratchMat[4] = p2.n[1];
  incidentScratchMat[5] = p3.n[1];
  incidentScratchMat[6] = p1.n[2];
  incidentScratchMat[7] = p2.n[2];
  incidentScratchMat[8] = p3.n[2];
  mat3.invert(incidentScratchMat, incidentScratchMat);
  incidentScratchVec3[0] = -p1.d;
  incidentScratchVec3[1] = -p2.d;
  incidentScratchVec3[2] = -p3.d;
  vec3.transformMat3(dst, incidentScratchVec3, incidentScratchMat);
}

enum CullWmoResult {
  CameraInsideAndExteriorVisible,
  CameraInside,
  CameraOutside,
}

export class WdtScene implements Viewer.SceneGfx {
  private terrainRenderers: Map<number, TerrainRenderer> = new Map();
  private adtWaterRenderers: Map<number, WaterRenderer> = new Map();
  private wmoWaterRenderers: Map<number, WaterRenderer> = new Map();
  private modelRenderers: Map<number, ModelRenderer> = new Map();
  private skyboxModelRenderers: Map<number, ModelRenderer> = new Map();
  private wmoRenderers: Map<number, WmoRenderer> = new Map();
  private debugWmoPortalRenderers: Map<number, DebugWmoPortalRenderer> = new Map();
  private skyboxRenderer: SkyboxRenderer;
  private loadingAdtRenderer: LoadingAdtRenderer;
  private renderInstListMain = new GfxRenderInstList();

  public ADT_LOD0_DISTANCE = 1000;

  private terrainProgram: GfxProgram;
  private waterProgram: GfxProgram;
  private modelProgram: GfxProgram;
  private wmoProgram: GfxProgram;
  private skyboxProgram: GfxProgram;
  private loadingAdtProgram: GfxProgram;
  private debugWmoPortalProgram: GfxProgram;

  private modelIdToDoodads: MapArray<number, DoodadData> = new MapArray();
  private wmoIdToDefs: MapArray<number, WmoDefinition> = new MapArray();

  public mainView = new View();
  private textureCache: TextureCache;
  public enableProgressiveLoading = false;
  public currentAdtCoords: [number, number] = [0, 0];
  public activeSkyboxModelId: number | undefined;
  public loadingAdts: [number, number][] = [];

  public debug = false;
  public cullingState = CullingState.Running;
  public cameraState = CameraState.Running;
  public frozenCamera = vec3.create();
  public frozenFrustum = new Frustum();
  private modelCamera = vec3.create();
  private modelFrustum = new Frustum();

  constructor(private device: GfxDevice, public world: WorldData | LazyWorldData, public renderHelper: GfxRenderHelper, private db: Database) {
    console.time('WdtScene construction');
    this.textureCache = new TextureCache(this.renderHelper.renderCache);
    this.terrainProgram = this.renderHelper.renderCache.createProgram(new TerrainProgram());
    this.waterProgram = this.renderHelper.renderCache.createProgram(new WaterProgram());
    this.modelProgram = this.renderHelper.renderCache.createProgram(new ModelProgram());
    this.wmoProgram = this.renderHelper.renderCache.createProgram(new WmoProgram());
    this.skyboxProgram = this.renderHelper.renderCache.createProgram(new SkyboxProgram());
    this.loadingAdtProgram = this.renderHelper.renderCache.createProgram(new LoadingAdtProgram());
    this.debugWmoPortalProgram = this.renderHelper.renderCache.createProgram(new DebugWmoPortalProgram());

    if (this.world.globalWmo) {
      this.setupWmoDef(this.world.globalWmoDef!);
      this.setupWmo(this.world.globalWmo);
    } else {
      for (let adt of this.world.adts) {
        this.setupAdt(adt);
      }
    }

    this.skyboxRenderer = new SkyboxRenderer(device, this.renderHelper);
    this.loadingAdtRenderer = new LoadingAdtRenderer(device, this.renderHelper);
    console.timeEnd('WdtScene construction');
  }

  public setupWmoDef(def: WmoDefinition) {
    this.wmoIdToDefs.append(def.wmoId, def);
    for (let doodad of def.doodads) {
      if (doodad === undefined) continue;
      this.modelIdToDoodads.append(doodad.modelId, doodad);
    }
  }

  public setupAdt(adt: AdtData) {
    if (this.terrainRenderers.has(adt.fileId)) {
      return;
    }

    this.terrainRenderers.set(adt.fileId, new TerrainRenderer(
      this.device,
      this.renderHelper,
      adt,
      this.textureCache,
    ));
    this.adtWaterRenderers.set(adt.fileId, new WaterRenderer(
      this.device,
      this.renderHelper,
      adt.liquids,
      adt.liquidTypes,
      this.textureCache,
    ));
    for (let lodData of adt.lodData) {
      for (let modelId of lodData.modelIds) {
        const model = adt.models.get(modelId)!;
        this.createModelRenderer(model);
      }
      for (let wmoDef of lodData.wmoDefs) {
        this.setupWmo(adt.wmos.get(wmoDef.wmoId)!);
        this.setupWmoDef(wmoDef);
      }
      for (let doodad of lodData.doodads) {
        this.modelIdToDoodads.append(doodad.modelId, doodad);
      }
    }
    if (adt.skyboxModelId !== undefined) {
      if (!this.skyboxModelRenderers.has(adt.skyboxModelId)) {
        const model = this.world.cache.models.get(adt.skyboxModelId)!;
        this.skyboxModelRenderers.set(model.fileId, new ModelRenderer(
          this.device,
          model,
          this.renderHelper,
          this.textureCache
        ));
        this.modelIdToDoodads.append(model.fileId, DoodadData.skyboxDoodad());
      }
    }
  }

  public setupWmo(wmo: WmoData) {
    if (this.wmoRenderers.has(wmo.fileId)) {
      return;
    }

    this.wmoRenderers.set(wmo.fileId, new WmoRenderer(this.device,
      wmo,
      this.textureCache,
      this.renderHelper,
    ));
    this.wmoWaterRenderers.set(wmo.fileId, new WaterRenderer(
      this.device,
      this.renderHelper,
      wmo.liquids,
      wmo.liquidTypes,
      this.textureCache
    ));
    if (wmo.portalVertices.length > 0) {
      this.debugWmoPortalRenderers.set(wmo.fileId, new DebugWmoPortalRenderer(
        this.device,
        this.renderHelper,
        wmo
      ));
    }
    for (let model of wmo.models.values()) {
      this.createModelRenderer(model);
    }
  }

  public createModelRenderer(model: ModelData) {
    if (!this.modelRenderers.has(model.fileId)) {
      this.modelRenderers.set(model.fileId, new ModelRenderer(this.device, model, this.renderHelper, this.textureCache));
    }
  }

  private shouldCull(): boolean {
    return this.cullingState !== CullingState.Paused;
  }

  public freezeCamera() {
    this.cameraState = CameraState.Frozen;
    vec3.copy(this.frozenCamera, this.mainView.cameraPos);
    for (let i in this.frozenFrustum.planes) {
      this.frozenFrustum.planes[i].copy(this.mainView.frustum.planes[i]);
    }
  }

  public getCameraAndFrustum(): [vec3, Frustum] {
    if (this.cameraState === CameraState.Frozen) {
      return [this.frozenCamera, this.frozenFrustum];
    } else {
      return [this.mainView.cameraPos, this.mainView.frustum];
    }
  }

  public unfreezeCamera() {
    this.cameraState = CameraState.Running;
  }

  private updateCullingState() {
    if (this.cullingState === CullingState.OneShot) {
      this.cullingState = CullingState.Paused;
    }
  }

  public resumeCulling() {
    this.cullingState = CullingState.Running;
  }

  public pauseCulling() {
    this.cullingState = CullingState.Paused;
  }

  public cullOneShot() {
    this.cullingState = CullingState.OneShot;
  }

  public cull() {
    if (this.world.globalWmo) {
      this.cullWmoDef(this.world.globalWmoDef!, this.world.globalWmo);
    } else {
      this.activeSkyboxModelId = undefined;
      const [worldCamera, worldFrustum] = this.getCameraAndFrustum();
      // Do a first pass and get candidate WMOs the camera's inside of,
      // disable WMOs not in the frustum, and determine if any ADTs are
      // visible based on where the camera is
      let exteriorVisible = true;
      for (let adt of this.world.adts) {
        adt.worldSpaceAABB.centerPoint(scratchVec3);
        const distance = vec3.distance(worldCamera, scratchVec3);
        adt.setLodLevel(distance < this.ADT_LOD0_DISTANCE ? 0 : 1);
        adt.setupWmoCandidates(worldCamera, worldFrustum);

        if (adt.insideWmoCandidates.length > 0) {
          for (let def of adt.insideWmoCandidates) {
            const wmo = adt.wmos.get(def.wmoId)!;
            const cullResult = this.cullWmoDef(def, wmo);
            if (cullResult === CullWmoResult.CameraInside) {
              exteriorVisible = false;
            }
          }
        }
      }

      for (let adt of this.world.adts) {
        if (exteriorVisible) {
          if (adt.skyboxModelId !== undefined) {
            let originalMinZ = adt.worldSpaceAABB.minZ;
            let originalMaxZ = adt.worldSpaceAABB.maxZ;
            adt.worldSpaceAABB.minZ = -Infinity;
            adt.worldSpaceAABB.maxZ = Infinity;
            if (adt.worldSpaceAABB.containsPoint(worldCamera)) {
              this.activeSkyboxModelId = adt.skyboxModelId;
            }
            adt.worldSpaceAABB.minZ = originalMinZ;
            adt.worldSpaceAABB.maxZ = originalMaxZ;
          }
          if (worldFrustum.contains(adt.worldSpaceAABB)) {
            adt.visible = true;
            for (let chunk of adt.chunkData) {
              chunk.setVisible(worldFrustum.contains(chunk.worldSpaceAABB));
            }
            for (let liquid of adt.liquids) {
              liquid.setVisible(worldFrustum.contains(liquid.worldSpaceAABB));
            }
            for (let doodad of adt.lodDoodads()) {
              doodad.setVisible(worldFrustum.contains(doodad.worldAABB));
            }
          } else {
            adt.setVisible(false);
          }
          for (let def of adt.visibleWmoCandidates) {
            const wmo = adt.wmos.get(def.wmoId)!;
            this.cullWmoDef(def, wmo);
          }
        } else {
          adt.setVisible(false);
          for (let def of adt.visibleWmoCandidates) {
            def.setVisible(false);
          }
        }
      }
    }
  }

  public cullWmoDef(def: WmoDefinition, wmo: WmoData): CullWmoResult {
    const [worldCamera, worldFrustum] = this.getCameraAndFrustum();
    vec3.transformMat4(this.modelCamera, worldCamera, def.invPlacementMatrix);
    this.modelFrustum.transform(worldFrustum, def.invPlacementMatrix);

    // Start with everything invisible
    def.setVisible(false);

    // Check if we're looking at this particular world-space WMO, then do the
    // rest of culling in model space
    def.visible = worldFrustum.contains(def.worldAABB);
    if (!def.visible) {
      return CullWmoResult.CameraOutside;
    }

    // Categorize groups by interior/exterior, and whether
    // the camera is present in them
    let exteriorGroupsInFrustum: number[] = [];
    let interiorMemberGroups: number[] = [];
    let exteriorMemberGroups: number[] = [];
    for (let [groupId, groupAABB] of wmo.groupDefAABBs.entries()) {
      const group = wmo.getGroup(groupId)!;
      if (groupAABB.containsPoint(this.modelCamera)) {
        if (group.bspContainsModelSpacePoint(this.modelCamera)) {
          if (!group.flags.exterior) {
            interiorMemberGroups.push(groupId);
          } else {
            exteriorMemberGroups.push(groupId);
          }
        }
        if (this.debug) {
          drawWorldSpaceAABB(getDebugOverlayCanvas2D(), this.mainView.clipFromWorldMatrix, group.scratchAABB, def.modelMatrix);
          group.drawBspNodes(this.modelCamera, def.modelMatrix, this.mainView.clipFromWorldMatrix);
        }
      }
      if (this.modelFrustum.contains(groupAABB) && group.flags.exterior) {
        exteriorGroupsInFrustum.push(groupId);
      }
    }

    let rootGroups: number[];
    if (interiorMemberGroups.length > 0) {
      rootGroups = interiorMemberGroups;
    } else if (exteriorMemberGroups.length > 0) {
      rootGroups = exteriorMemberGroups.concat(exteriorGroupsInFrustum);
    } else {
      rootGroups = exteriorGroupsInFrustum;
    }

    // If we still don't have any groups, the user might be flying out of
    // bounds, so just show the closest visible one. Or if we're in a global WMO
    // map, just render everything
    if (rootGroups.length === 0) {
      if (this.world.globalWmo) {
        def.setVisible(true);
      } else {
        let closestGroupId = undefined;
        let closestDistance = Infinity;
        for (let [groupId, groupAABB] of wmo.groupDefAABBs.entries()) {
          if (this.modelFrustum.contains(groupAABB)) {
            const dist = groupAABB.distanceVec3(this.modelCamera);
            if (dist < closestDistance) {
              closestDistance = dist;
              closestGroupId = groupId;
            }
          }
        }
        if (closestGroupId !== undefined) {
          def.setGroupVisible(closestGroupId, true);
        }
      }
    }

    // do portal culling on the root groups
    let visibleGroups: number[] = [];
    for (let groupId of rootGroups) {
      wmo.portalCull(this.modelCamera, this.modelFrustum, groupId, visibleGroups);
    }

    let hasExternalGroup = false;
    for (let groupId of visibleGroups) {
      const group = wmo.getGroup(groupId)!;
      if (group.flags.exterior) {
        hasExternalGroup = true;
      }
      def.setGroupVisible(groupId, true);
    }

    if (hasExternalGroup) {
      for (let groupId of exteriorGroupsInFrustum) {
        def.setGroupVisible(groupId, true);
      }
    }

    if (interiorMemberGroups.length > 0) {
      if (hasExternalGroup) {
        return CullWmoResult.CameraInsideAndExteriorVisible;
      } else {
        return CullWmoResult.CameraInside;
      }
    } else {
      return CullWmoResult.CameraOutside;
    }
  }

  private prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
    this.mainView.setupFromViewerInput(viewerInput);

    const template = this.renderHelper.pushTemplateRenderInst();
    template.setMegaStateFlags({ cullMode: GfxCullMode.Back });
    template.setGfxProgram(this.skyboxProgram);
    template.setBindingLayouts(SkyboxProgram.bindingLayouts);

    BaseProgram.layoutUniformBufs(
      template,
      viewerInput.camera.projectionMatrix,
      this.mainView,
      this.db.getGlobalLightingData(this.mainView.cameraPos, this.mainView.time)
    );
    this.renderHelper.renderInstManager.setCurrentRenderInstList(this.renderInstListMain);
    this.skyboxRenderer.prepareToRenderSkybox(this.renderHelper.renderInstManager)

    template.setGfxProgram(this.loadingAdtProgram);
    template.setBindingLayouts(LoadingAdtProgram.bindingLayouts);
    this.loadingAdtRenderer.update(this.mainView);
    this.loadingAdtRenderer.prepareToRenderLoadingBox(
      this.renderHelper.renderInstManager,
      this.loadingAdts
    );

    if (this.shouldCull()) {
      this.cull();
    }

    template.setGfxProgram(this.terrainProgram);
    template.setBindingLayouts(TerrainProgram.bindingLayouts);
    for (let renderer of this.terrainRenderers.values()) {
      renderer.prepareToRenderTerrain(this.renderHelper.renderInstManager);
    }

    template.setGfxProgram(this.waterProgram);
    template.setBindingLayouts(WaterProgram.bindingLayouts);
    for (let renderer of this.adtWaterRenderers.values()) {
      renderer.update(this.mainView);
      renderer.prepareToRenderAdtWater(this.renderHelper.renderInstManager);
    }
    for (let [wmoId, renderer] of this.wmoWaterRenderers.entries()) {
      const defs = this.wmoIdToDefs.get(wmoId)!;
      renderer.update(this.mainView);
      renderer.prepareToRenderWmoWater(this.renderHelper.renderInstManager, defs);
    }

    template.setGfxProgram(this.wmoProgram);
    template.setBindingLayouts(WmoProgram.bindingLayouts);
    for (let [wmoId, renderer] of this.wmoRenderers.entries()) {
      const defs = this.wmoIdToDefs.get(wmoId)!;
      renderer.prepareToRenderWmo(this.renderHelper.renderInstManager, defs);
    }

    template.setBindingLayouts(ModelProgram.bindingLayouts);
    template.setGfxProgram(this.modelProgram);
    if (this.activeSkyboxModelId !== undefined) {
      const renderer = this.skyboxModelRenderers.get(this.activeSkyboxModelId)!;
      renderer.update(this.mainView);
      renderer.prepareToRenderModel(
        this.renderHelper.renderInstManager,
        this.modelIdToDoodads.get(this.activeSkyboxModelId)
      );
    }
    for (let [modelId, renderer] of this.modelRenderers.entries()) {
      const doodads = this.modelIdToDoodads.get(modelId)!;
      const visibleDoodads = doodads.filter(doodad => doodad.visible);
      if (visibleDoodads.length === 0) continue;
      renderer.update(this.mainView);
      renderer.prepareToRenderModel(this.renderHelper.renderInstManager, visibleDoodads);
    }

    this.renderHelper.renderInstManager.popTemplateRenderInst();
    this.renderHelper.prepareToRender();
    this.updateCullingState();
  }

  private updateCurrentAdt() {
    const adtCoords = this.getCurrentAdtCoords();
    if (adtCoords) {
      if (this.currentAdtCoords[0] !== adtCoords[0] || this.currentAdtCoords[1] !== adtCoords[1]) {
        this.currentAdtCoords = adtCoords;
        if (this.enableProgressiveLoading && 'onEnterAdt' in this.world) {
          const newCoords = this.world.onEnterAdt(this.currentAdtCoords, (coord: AdtCoord, adt: AdtData) => {
            this.loadingAdts = this.loadingAdts.filter(([x, y]) => !(x === coord[0] && y === coord[1]));
            this.setupAdt(adt);
          });
          for (let coord of newCoords) {
            this.loadingAdts.push(coord);
          }
        }
      }
    }
  }

  public getCurrentAdtCoords(): [number, number] | undefined {
    const [worldY, worldX, _] = this.mainView.cameraPos;
    const adt_dimension = 533.33;
    const x_coord = Math.floor(32 - worldX / adt_dimension);
    const y_coord = Math.floor(32 - worldY / adt_dimension);
    if (x_coord >= 0 && x_coord < 64 && y_coord >= 0 && y_coord < 64) {
      return [x_coord, y_coord];
    }
    return undefined;
  }

  public adjustCameraController(c: CameraController) {
      c.setSceneMoveSpeedMult(0.11);
  }

  render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
    viewerInput.camera.setClipPlanes(0.1);
    this.updateCurrentAdt();
    const renderInstManager = this.renderHelper.renderInstManager;

    const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, standardFullClearRenderPassDescriptor);
    const mainDepthDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, viewerInput, standardFullClearRenderPassDescriptor);

    const builder = this.renderHelper.renderGraph.newGraphBuilder();

    const mainColorTargetID = builder.createRenderTargetID(mainColorDesc, 'Main Color');
    const mainDepthTargetID = builder.createRenderTargetID(mainDepthDesc, 'Main Depth');
    builder.pushPass((pass) => {
      pass.setDebugName('Main');
      pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
      pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
      pass.exec((passRenderer) => {
        this.renderInstListMain.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
      });
    });
    pushAntialiasingPostProcessPass(builder, this.renderHelper, viewerInput, mainColorTargetID);
    builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);

    this.prepareToRender(device, viewerInput);
    this.renderHelper.renderGraph.execute(builder);
    this.renderInstListMain.reset();
    renderInstManager.resetRenderInsts();
  }

  destroy(device: GfxDevice): void {
    for (let renderer of this.terrainRenderers.values()) {
      renderer.destroy(device);
    };
    for (let renderer of this.modelRenderers.values()) {
      renderer.destroy(device);
    }
    for (let renderer of this.wmoRenderers.values()) {
      renderer.destroy(device);
    }
    this.skyboxRenderer.destroy(device);
    this.textureCache.destroy(device);
    this.renderHelper.destroy();
  }
}

class WdtSceneDesc implements Viewer.SceneDesc {
  public id: string;

  constructor(public name: string, public fileId: number, public lightdbMapId: number) {
    this.id = `${name}-${fileId}`;
  }

  public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
    const dataFetcher = context.dataFetcher;
    await initSheepfile(dataFetcher);
    const db = new Database(this.lightdbMapId);
    await db.load(dataFetcher);
    const cache = new WowCache(dataFetcher, db);
    const renderHelper = new GfxRenderHelper(device);
    rust.init_panic_hook();
    const wdt = new WorldData(this.fileId, cache);
    console.time('loading wdt');
    await wdt.load(dataFetcher, cache);
    console.timeEnd('loading wdt');
    return new WdtScene(device, wdt, renderHelper, db);
  }
}

class ContinentSceneDesc implements Viewer.SceneDesc {
  public id: string;

  constructor(public name: string, public fileId: number, public startX: number, public startY: number, public lightdbMapId: number) {
    this.id = `${name}-${fileId}`;
  }

  public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
    const dataFetcher = context.dataFetcher;
    await initSheepfile(dataFetcher);
    const db = new Database(this.lightdbMapId);
    await db.load(dataFetcher);
    const cache = new WowCache(dataFetcher, db);
    const renderHelper = new GfxRenderHelper(device);
    rust.init_panic_hook();
    const wdt = new LazyWorldData(this.fileId, [this.startX, this.startY], 2, dataFetcher, cache);
    console.time('loading wdt')
    await wdt.load();
    console.timeEnd('loading wdt')
    return new WdtScene(device, wdt, renderHelper, db);
  }
}

const vanillaSceneDescs = [
    "Eastern Kingdoms",
    new ContinentSceneDesc("Ironforge, Dun Morogh", 775971, 33, 40, 0),
    new ContinentSceneDesc("Stormwind, Elwynn Forest", 775971, 31, 48, 0),
    new ContinentSceneDesc("Undercity, Tirisfal Glades", 775971, 31, 28, 0),
    new ContinentSceneDesc("Lakeshire, Redridge Mountains", 775971, 36, 49, 0),
    new ContinentSceneDesc("Blackrock Mountain, Burning Steppes", 775971, 34, 45, 0),
    new ContinentSceneDesc("Booty Bay, Stranglethorn Vale", 775971, 31, 58, 0),
    new ContinentSceneDesc("Light's Hope Chapel, Eastern Plaguelands", 775971, 41, 27, 0),
    new ContinentSceneDesc("Aerie Peak, Hinterlands", 775971, 35, 31, 0),
    new ContinentSceneDesc("Tarren Mill, Hillsbrad Foothills", 775971, 33, 32, 0),
    new ContinentSceneDesc("Stonewrought Dam, Loch Modan", 775971, 38, 40, 0),
    new ContinentSceneDesc("Kargath, Badlands", 775971, 36, 44, 0),
    new ContinentSceneDesc("Thorium Point, Searing Gorge", 775971, 34, 44, 0),
    new ContinentSceneDesc("Stonard, Swamp of Sorrows", 775971, 38, 51, 0),
    new ContinentSceneDesc("Nethergarde Keep, Blasted Lands", 775971, 38, 52, 0),
    new ContinentSceneDesc("The Dark Portal, Blasted Lands", 775971, 38, 54, 0),
    new ContinentSceneDesc("Darkshire, Duskwood", 775971, 34, 51, 0),
    new ContinentSceneDesc("Grom'gol Base Camp, Stranglethorn Vale", 775971, 31, 55, 0),
    new ContinentSceneDesc("Gurubashi Arena, Stranglethorn Vale", 775971, 31, 56, 0),
    new ContinentSceneDesc("Sentinel Hill, Westfall", 775971, 30, 51, 0),
    new ContinentSceneDesc("Kharazan, Deadwind Pass", 775971, 35, 52, 0),
    new ContinentSceneDesc("Southshore, Hillsbrad Foothills", 775971, 33, 33, 0),

    "Kalimdor",
    new ContinentSceneDesc("Thunder Bluff, Mulgore", 782779, 31, 34, 1),
    new ContinentSceneDesc("Darnassus, Teldrassil", 782779, 27, 13, 1),
    new ContinentSceneDesc("GM Island", 782779, 1, 1, 1),
    new ContinentSceneDesc("Archimonde's Bones, Hyjal", 782779, 38, 22, 1),
    new ContinentSceneDesc("Everlook, Winterspring", 782779, 40, 19, 1),
    new ContinentSceneDesc("Auberdine, Darkshore", 782779, 31, 19, 1),
    new ContinentSceneDesc("Astranaar, Ashenvale", 782779, 32, 26, 1),
    new ContinentSceneDesc("Mor'shan Rampart, Barrens", 782779, 36, 29, 1),
    new ContinentSceneDesc("Splintertree Post, Ashenvale", 782779, 36, 27, 1),
    new ContinentSceneDesc("Bloodvenom Post, Felwood", 782779, 32, 22, 1),
    new ContinentSceneDesc("Talonbranch Glade, Felwood", 782779, 34, 24, 1),
    new ContinentSceneDesc("The Crossroads, Barrens", 782779, 36, 32, 1),
    new ContinentSceneDesc("Orgrimmar, Durotar", 782779, 40, 29, 1),
    new ContinentSceneDesc("Ratchet, Barrens", 782779, 39, 33, 1),
    new ContinentSceneDesc("Sun Rock Retreat, Stonetalon Mountains", 782779, 30, 30, 1),
    new ContinentSceneDesc("Nijel's Point, Desolace", 782779, 29, 31, 1),
    new ContinentSceneDesc("Shadowprey Village, Desolace", 782779, 25, 35, 1),
    new ContinentSceneDesc("Dire Maul Arena, Feralas", 782779, 29, 38, 1),
    new ContinentSceneDesc("Thalanaar, Feralas", 782779, 33, 40, 1),
    new ContinentSceneDesc("Camp Mojache, Feralas", 782779, 31, 40, 1),
    new ContinentSceneDesc("Feathermoon Stronghold, Feralas", 782779, 25, 40, 1),
    new ContinentSceneDesc("Cenarion Hold, Silithus", 782779, 30, 44, 1),
    new ContinentSceneDesc("Marshal's Refuge, Un'Goro Crater", 782779, 34, 43, 1),
    new ContinentSceneDesc("Gadgetzan, Tanaris", 782779, 39, 45, 1),
    new ContinentSceneDesc("Mirage Raceway, Thousand Needles", 782779, 39, 43, 1),
    new ContinentSceneDesc("Freewind Post, Thousand Needles", 782779, 35, 41, 1),
    new ContinentSceneDesc("Theramore Isle, Dustwallow Marsh", 782779, 40, 39, 1),
    new ContinentSceneDesc("Alcaz Island, Dustwallow Marsh", 782779, 41, 37, 1),

    "Instances",
    new WdtSceneDesc('Zul-Farak', 791169, 209),
    new WdtSceneDesc('Blackrock Depths', 780172, 230),
    new WdtSceneDesc('Scholomance', 790713, 289),
    new WdtSceneDesc("Deeprun Tram", 780788, 369),
    new WdtSceneDesc("Deadmines", 780605, 36),
    new WdtSceneDesc("Shadowfang Keep", 790796, 33),
    new WdtSceneDesc("Blackrock Spire", 780175, 229),
    new WdtSceneDesc("Stratholme", 791063, 329),
    new WdtSceneDesc('Mauradon', 788656, 349),
    new WdtSceneDesc('Wailing Caverns', 791429, 43),
    new WdtSceneDesc('Razorfen Kraul', 790640, 47),
    new WdtSceneDesc('Razorfen Downs', 790517, 129),
    new WdtSceneDesc('Blackfathom Deeps', 780169, 48),
    new WdtSceneDesc('Uldaman', 791372, 70),
    new WdtSceneDesc('Gnomeregon', 782773, 90),
    new WdtSceneDesc('Sunken Temple', 791166, 109),
    new WdtSceneDesc('Scarlet Monastery - Graveyard', 788662, 189),
    new WdtSceneDesc('Scarlet Monastery - Cathedral', 788662, 189),
    new WdtSceneDesc('Scarlet Monastery - Library', 788662, 189),
    new WdtSceneDesc('Scarlet Monastery - Armory', 788662, 189),
    new WdtSceneDesc("Ragefire Chasm", 789981, 389),
    new WdtSceneDesc("Dire Maul", 780814, 429),

    "Raids",
    new WdtSceneDesc("Onyxia's Lair", 789922, 249),
    new WdtSceneDesc("Molten Core", 788659, 409),
    new WdtSceneDesc("Blackwing Lair", 780178, 469),
    new WdtSceneDesc("Zul'gurub", 791432, 309),
    new WdtSceneDesc("Naxxramas", 827115, 533),
    new WdtSceneDesc("Ahn'Qiraj Temple", 775840, 531),
    new WdtSceneDesc("Ruins of Ahn'qiraj", 775637, 509),

    "PvP",
    new WdtSceneDesc('Alterac Valley', 790112, 30), // AKA pvpzone01
    new WdtSceneDesc('Warsong Gulch', 790291, 489), // AKA pvpzone03
    new WdtSceneDesc('Arathi Basin', 790377, 529), // AKA pvpzone04

    "Unreleased",
    new WdtSceneDesc('PvP Zone 02 ("Azshara Crater")', 861092, 0),
    new WdtSceneDesc('Dragon Isles, Developer Island', 857684, 0),
    new WdtSceneDesc('Swamp of Sorrows Prototype, Developer Island', 857684, 0),
    new WdtSceneDesc('Water test, Developer Island', 857684, 0),
    new WdtSceneDesc('Verdant Fields, Emerald Dream', 780817, 0),
    new WdtSceneDesc('Emerald Forest, Emerald Dream', 780817, 0),
    new WdtSceneDesc('Untextured canyon, Emerald Dream', 780817, 0),
    new WdtSceneDesc('Test 01', 2323096, 0),
    new WdtSceneDesc('Scott Test', 863335, 0),
    new WdtSceneDesc('Collin Test', 863984, 0),
    new WdtSceneDesc('Scarlet Monastery Prototype', 865519, 189),
];

const bcSceneDescs = [
    "Instances",
    new WdtSceneDesc("Hellfire Citadel: The Shattered Halls", 831277, 540),
    new WdtSceneDesc("Hellfire Citadel: The Blood Furnace", 830642, 542),
    new WdtSceneDesc("Hellfire Citadel: Ramparts", 832154, 543),
    new WdtSceneDesc("Coilfang: The Steamvault", 828422, 545),
    new WdtSceneDesc("Coilfang: The Underbog", 831262, 546),
    new WdtSceneDesc("Coilfang: The Slave Pens", 830731, 547),
    new WdtSceneDesc("Caverns of Time: The Escape from Durnholde", 833998, 560),
    new WdtSceneDesc("Tempest Keep: The Arcatraz", 832070, 552),
    new WdtSceneDesc("Tempest Keep: The Botanica", 833950, 553),
    new WdtSceneDesc("Tempest Keep: The Mechanar", 831974, 554),
    new WdtSceneDesc("Auchindoun: Shadow Labyrinth", 828331, 555),
    new WdtSceneDesc("Auchindoun: Sethekk Halls", 828811, 556),
    new WdtSceneDesc("Auchindoun: Mana-Tombs", 830899, 557),
    new WdtSceneDesc("Auchindoun: Auchenai Crypts", 830415, 558),
    new WdtSceneDesc("The Sunwell: Magister's Terrace", 834223, 585),

    "Raids",
    new WdtSceneDesc("Tempest Keep", 832484, 550),
    new WdtSceneDesc("Karazahn", 834192, 532),
    new WdtSceneDesc("Caverns of Time: Hyjal", 831824, 534),
    new WdtSceneDesc("Black Temple", 829630, 565),
    new WdtSceneDesc("Gruul's Lair", 833180, 565),
    new WdtSceneDesc("Zul'Aman", 815727, 568),
    new WdtSceneDesc("The Sunwell: Plateau", 832953, 580),
    new WdtSceneDesc("Magtheridon's Lair", 833183, 544),
    new WdtSceneDesc("Coilfang: Serpentshrine Cavern", 829900, 548),

    "PvP",
    new WdtSceneDesc('Eye of the Storm', 788893, 566),
    new WdtSceneDesc('Arena: Nagrand', 790469, 559),
    new WdtSceneDesc("Arena: Blade's Edge", 780261, 562),

    "Outland",
    new ContinentSceneDesc("The Dark Portal", 828395, 29, 32, 530),
    new ContinentSceneDesc("Shattrath", 828395, 22, 35, 530),
];

const wotlkSceneDescs = [
    "Instances",
    new WdtSceneDesc("Ebon Hold", 818210, 609),
    new WdtSceneDesc("Utgarde Keep", 825743, 574),
    new WdtSceneDesc("Utgarde Pinnacle", 827661, 575),
    new WdtSceneDesc("Drak'Theron Keep", 820968, 600),
    new WdtSceneDesc("Violet Hold", 818205, 608),
    new WdtSceneDesc("Gundrak", 818626, 604),
    new WdtSceneDesc("Ahn'kahet: The Old Kingdom", 818056, 619),
    new WdtSceneDesc("Azjol'Nerub", 818693, 601),
    new WdtSceneDesc("Halls of Stone", 824642, 599),
    new WdtSceneDesc("Halls of Lightning", 824768, 602),
    new WdtSceneDesc("The Oculus", 819814, 578),
    new WdtSceneDesc("The Nexus", 821331, 576),
    new WdtSceneDesc("The Culling of Stratholme", 826005, 0), // map is actually 595
    new WdtSceneDesc("Trial of the Champion", 817987, 650),
    new WdtSceneDesc("The Forge of Souls", 818965, 632),
    new WdtSceneDesc("Pit of Saron", 827056, 0), // map id is actually 658
    new WdtSceneDesc("Halls of Reflection", 818690, 668),

    "Raids",
    new WdtSceneDesc("Icecrown Citadel", 820428, 0), // map id is actually 631
    new WdtSceneDesc("Ulduar", 825015, 603),
    new WdtSceneDesc("The Obsidian Sanctum", 820448, 615),
    new WdtSceneDesc("The Ruby Sanctum", 821024, 724),
    new WdtSceneDesc("Vault of Archavon", 826589, 624),
    new WdtSceneDesc("Trial of the Crusader", 818173, 649),
    new WdtSceneDesc("The Eye of Eternity", 822560, 616),

    "PvP",
    new WdtSceneDesc('Strand of the Ancients', 789579, 607),
    new WdtSceneDesc('Isle of Conquest', 821811, 0), // map id is actually 628
    new WdtSceneDesc("Arena: Dalaran Sewers", 780309, 617),
    new WdtSceneDesc("Arena: The Ring of Valor", 789925, 618),

    "Northrend",
    new ContinentSceneDesc("???", 822688, 31, 28, 571),
];

export const vanillaSceneGroup: Viewer.SceneGroup = {
  id: 'WorldOfWarcraft',
  name: 'World of Warcraft',
  sceneDescs: vanillaSceneDescs,
  hidden: false,
};

export const bcSceneGroup: Viewer.SceneGroup = {
  id: 'WorldOfWarcraftBC',
  name: 'World of Warcraft: The Burning Crusade',
  sceneDescs: bcSceneDescs,
  hidden: true,
};

export const wotlkSceneGroup: Viewer.SceneGroup = {
  id: 'WorldOfWarcraftWOTLK',
  name: 'World of Warcraft: Wrath of the Lich King',
  sceneDescs: wotlkSceneDescs,
  hidden: true,
};