import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import JSZip from 'jszip';
import { Box, Copy, FilePlus2, Grid3X3, Loader2, Move, Plus, RotateCw, Trash2, WandSparkles, X } from 'lucide-react';
import { api, getAuthToken, type LibraryFileListItem, type LibraryFileUploadResponse } from '../api/client';
import { Button } from './Button';
import {
  createGeometryFromMesh,
  parse3MF,
  type BuildItem,
  type MeshData,
  type Parsed3MFData,
} from './ModelViewer';
import { useToast } from '../contexts/ToastContext';

interface PlateEditorModalProps {
  libraryFileId: number;
  filename: string;
  fileType?: string;
  folderId?: number | null;
  plateId?: number | null;
  initialModels?: Array<{ id: number; filename: string; fileType?: string }>;
  buildVolume?: { x: number; y: number; z: number };
  onClose: () => void;
  onSaved: (file: LibraryFileUploadResponse) => void;
}

interface EditablePart {
  key: string;
  objectId: string;
  sourceBuildIndex?: number;
  /** Meshes are present for objects imported from another file. The original
   * 3MF objects stay in the source archive and only need a new build item. */
  sourceMeshes?: MeshData[];
  sourceFormat?: '3mf' | 'stl';
  label?: string;
  group: THREE.Group;
  meshGroup: THREE.Group;
  center: THREE.Vector3;
  width: number;
  depth: number;
}

const SWAP_YZ = new THREE.Matrix4().set(
  1, 0, 0, 0,
  0, 0, 1, 0,
  0, 1, 0, 0,
  0, 0, 0, 1,
);
const STL_TO_THREE = new THREE.Matrix4().makeRotationX(-Math.PI / 2);

function threeMatrixFrom3mf(matrix: THREE.Matrix4): THREE.Matrix4 {
  return SWAP_YZ.clone().multiply(matrix).multiply(SWAP_YZ);
}

function matrix3mfFromThree(matrix: THREE.Matrix4): string {
  const e = matrix.elements;
  return [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10], e[12], e[13], e[14]]
    .map((value) => Number(value.toFixed(6)))
    .join(' ');
}

function arrangeEditableParts(parts: EditablePart[], buildVolume: { x: number; y: number }): void {
  let cursorX = 8;
  let cursorZ = 8;
  let rowDepth = 0;
  for (const part of parts) {
    part.group.rotation.set(0, 0, 0);
    if (cursorX + part.width > buildVolume.x - 8 && cursorX > 8) {
      cursorX = 8;
      cursorZ += rowDepth + 8;
      rowDepth = 0;
    }
    part.group.position.x = cursorX + part.width / 2;
    part.group.position.z = cursorZ + part.depth / 2;
    cursorX += part.width + 8;
    rowDepth = Math.max(rowDepth, part.depth);
  }
}

function makePartGroup(
  meshes: MeshData[],
  objectId: string,
  transform: THREE.Matrix4,
  isStl: boolean,
  materialColor = '#00ae42',
): { group: THREE.Group; meshGroup: THREE.Group; center: THREE.Vector3; width: number; depth: number } {
  const meshGroup = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: materialColor,
    roughness: 0.64,
    metalness: 0,
  });

  for (const meshData of meshes) {
    const geometry = isStl
      ? (() => {
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute('position', new THREE.Float32BufferAttribute(meshData.vertices, 3));
          geometry.setIndex(meshData.triangles);
          geometry.computeVertexNormals();
          return geometry;
        })()
      : createGeometryFromMesh(meshData);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.userData.objectId = objectId;
    meshGroup.add(mesh);
  }

  const box = new THREE.Box3().setFromObject(meshGroup);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  meshGroup.position.copy(center).multiplyScalar(-1);

  const group = new THREE.Group();
  group.add(meshGroup);
  const centeredTransform = transform.clone().multiply(new THREE.Matrix4().makeTranslation(center.x, center.y, center.z));
  centeredTransform.decompose(group.position, group.quaternion, group.scale);
  group.userData.objectId = objectId;
  group.userData.baseTransform = transform.clone();
  group.updateMatrixWorld(true);

  return { group, meshGroup, center, width: size.x, depth: size.z };
}

function buildStlMeshData(geometry: THREE.BufferGeometry): MeshData {
  const positions = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const vertices: number[] = [];
  const triangles: number[] = [];
  const readIndex = (i: number) => index ? index.getX(i) : i;
  const vertexCount = index ? index.count : positions.count;
  for (let i = 0; i < vertexCount; i += 3) {
    const base = vertices.length / 3;
    for (let j = 0; j < 3; j += 1) {
      const source = readIndex(i + j);
      vertices.push(positions.getX(source), positions.getY(source), positions.getZ(source));
    }
    triangles.push(base, base + 1, base + 2);
  }
  return { vertices, triangles, extruder: 0 };
}

function allocateObjectId(usedIds: Set<string>): string {
  let next = 1;
  for (const id of usedIds) {
    const numeric = Number.parseInt(id, 10);
    if (Number.isFinite(numeric)) next = Math.max(next, numeric + 1);
  }
  while (usedIds.has(String(next))) next += 1;
  const allocated = String(next);
  usedIds.add(allocated);
  return allocated;
}

async function importModelBytes(
  bytes: ArrayBuffer,
  label: string,
  currentParts: EditablePart[],
  existingObjectIds: Iterable<string>,
  buildVolume: { x: number; y: number },
): Promise<EditablePart[]> {
  const extension = label.split('.').pop()?.toLowerCase();
  const imported: EditablePart[] = [];
  const usedIds = new Set([...existingObjectIds, ...currentParts.map((part) => part.objectId)]);

  if (extension === 'stl') {
    const raw = new STLLoader().parse(bytes);
    raw.computeVertexNormals();
    const sourceMesh = buildStlMeshData(raw);
    raw.rotateX(-Math.PI / 2);
    const box = new THREE.Box3().setFromBufferAttribute(raw.getAttribute('position') as THREE.BufferAttribute);
    const objectId = allocateObjectId(usedIds);
    const partData = makePartGroup([{
      vertices: Array.from(raw.getAttribute('position').array as ArrayLike<number>),
      triangles: Array.from({ length: raw.getAttribute('position').count }, (_, index) => index),
      extruder: 0,
    }], objectId, new THREE.Matrix4(), true);
    partData.group.position.set(buildVolume.x / 2, partData.center.y - box.min.y, buildVolume.y / 2);
    imported.push({
      key: `part-${Date.now()}-${imported.length}`,
      objectId,
      sourceMeshes: [sourceMesh],
      sourceFormat: 'stl',
      label,
      group: partData.group,
      meshGroup: partData.meshGroup,
      center: partData.center,
      width: partData.width,
      depth: partData.depth,
    });
    return imported;
  }

  if (extension !== '3mf') throw new Error(`${label} is not an STL or 3MF model`);
  const parsed = await parse3MF(bytes);
  const items: BuildItem[] = parsed.buildItems.length > 0
    ? parsed.buildItems
    : Array.from(parsed.objects.values()).map((object) => ({ objectId: object.id, transform: new THREE.Matrix4(), plateId: null } satisfies BuildItem));
  const outputObjectIds = new Map<string, string>();
  for (const [index, item] of items.entries()) {
    const object = parsed.objects.get(item.objectId);
    if (!object) continue;
    const outputObjectId = outputObjectIds.get(item.objectId) ?? allocateObjectId(usedIds);
    outputObjectIds.set(item.objectId, outputObjectId);
    const partData = makePartGroup(object.meshes, outputObjectId, threeMatrixFrom3mf(item.transform), false);
    imported.push({
      key: `part-${Date.now()}-${imported.length}`,
      objectId: outputObjectId,
      sourceMeshes: object.meshes,
      sourceFormat: '3mf',
      sourceBuildIndex: item.buildIndex ?? index,
      label,
      group: partData.group,
      meshGroup: partData.meshGroup,
      center: partData.center,
      width: partData.width,
      depth: partData.depth,
    });
  }

  if (imported.length > 0) {
    const importedBox = new THREE.Box3();
    for (const part of imported) {
      part.group.updateMatrixWorld(true);
      importedBox.union(new THREE.Box3().setFromObject(part.group));
    }
    const correction = new THREE.Vector3(
      buildVolume.x / 2 - (importedBox.min.x + importedBox.max.x) / 2,
      -importedBox.min.y,
      buildVolume.y / 2 - (importedBox.min.z + importedBox.max.z) / 2,
    );
    for (const part of imported) part.group.position.add(correction);
  }
  return imported;
}

function meshXml(meshes: MeshData[]): string {
  const vertices: string[] = [];
  const triangles: string[] = [];
  let vertexOffset = 0;
  for (const mesh of meshes) {
    for (let i = 0; i < mesh.vertices.length; i += 3) {
      vertices.push(`<vertex x="${mesh.vertices[i]}" y="${mesh.vertices[i + 1]}" z="${mesh.vertices[i + 2]}"/>`);
    }
    for (let i = 0; i < mesh.triangles.length; i += 3) {
      triangles.push(`<triangle v1="${mesh.triangles[i] + vertexOffset}" v2="${mesh.triangles[i + 1] + vertexOffset}" v3="${mesh.triangles[i + 2] + vertexOffset}"/>`);
    }
    vertexOffset += mesh.vertices.length / 3;
  }
  return `<mesh><vertices>${vertices.join('')}</vertices><triangles>${triangles.join('')}</triangles></mesh>`;
}

function partTransform3mf(part: EditablePart): THREE.Matrix4 {
  part.group.updateMatrixWorld(true);
  const full = part.group.matrixWorld.clone().multiply(part.meshGroup.matrix);
  return part.sourceFormat === 'stl'
    ? STL_TO_THREE.clone().invert().multiply(full).multiply(STL_TO_THREE)
    : SWAP_YZ.clone().multiply(full).multiply(SWAP_YZ);
}

async function makeStandalone3mf(parts: EditablePart[]): Promise<Blob> {
  const objectParts = new Map<string, EditablePart>();
  for (const part of parts) {
    if (part.sourceMeshes?.length && !objectParts.has(part.objectId)) objectParts.set(part.objectId, part);
  }
  const objects = Array.from(objectParts.values()).map((part) => (
    `<object id="${part.objectId}" type="model">${meshXml(part.sourceMeshes ?? [])}</object>`
  )).join('');
  const items = parts.map((part) => (
    `<item objectid="${part.objectId}" transform="${matrix3mfFromThree(partTransform3mf(part))}"/>`
  )).join('');
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unit="millimeter">
  <resources>${objects}</resources>
  <build>${items}</build>
</model>`;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>');
  zip.file('3D/3dmodel.model', model);
  return zip.generateAsync({ type: 'blob', mimeType: 'model/3mf' });
}

async function makeEdited3mf(
  source: ArrayBuffer,
  parts: EditablePart[],
  parsed: Parsed3MFData,
  plateId: number | null | undefined,
): Promise<Blob> {
  const zip = await JSZip.loadAsync(source);
  const modelPath = Object.keys(zip.files).find((name) => name === '3D/3dmodel.model' || name.endsWith('/3dmodel.model'));
  if (!modelPath) throw new Error('The 3MF does not contain a model file');
  const xml = await zip.files[modelPath].async('string');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const build = doc.getElementsByTagName('build')[0];
  if (!build) throw new Error('The 3MF does not contain a build plate');
  const itemNodes = Array.from(build.children).filter((element) => element.localName === 'item');
  const activeIndexes = new Set(
    parsed.buildItems
      .filter((item) => plateId == null || item.plateId === plateId)
      .map((item) => item.buildIndex)
      .filter((index): index is number => index != null),
  );
  const nodesToReplace = activeIndexes.size === 0
    ? itemNodes
    : itemNodes.filter((_node, index) => activeIndexes.has(index));
  const template = nodesToReplace[0] ?? itemNodes[0] ?? doc.createElement('item');
  // Keep the next untouched item as the insertion anchor. The original first
  // active node is removed below, so it cannot safely be passed to
  // `insertBefore` afterwards.
  const insertBefore = nodesToReplace[0]?.nextElementSibling ?? null;
  for (const node of nodesToReplace) build.removeChild(node);
  const originalObjectIds = new Set(parsed.objects.keys());
  const resources = doc.getElementsByTagName('resources')[0];
  if (resources) {
    const existingResourceIds = new Set(
      Array.from(resources.children)
        .map((element) => element.getAttribute('id'))
        .filter((id): id is string => !!id),
    );
    for (const part of parts) {
      if (!part.sourceMeshes?.length || originalObjectIds.has(part.objectId) || existingResourceIds.has(part.objectId)) continue;
      const object = doc.createElementNS(doc.documentElement.namespaceURI, 'object');
      object.setAttribute('id', part.objectId);
      object.setAttribute('type', 'model');
      const mesh = doc.createElementNS(doc.documentElement.namespaceURI, 'mesh');
      const vertices = doc.createElementNS(doc.documentElement.namespaceURI, 'vertices');
      const triangles = doc.createElementNS(doc.documentElement.namespaceURI, 'triangles');
      let vertexOffset = 0;
      for (const meshData of part.sourceMeshes) {
        for (let index = 0; index < meshData.vertices.length; index += 3) {
          const vertex = doc.createElementNS(doc.documentElement.namespaceURI, 'vertex');
          vertex.setAttribute('x', String(meshData.vertices[index]));
          vertex.setAttribute('y', String(meshData.vertices[index + 1]));
          vertex.setAttribute('z', String(meshData.vertices[index + 2]));
          vertices.appendChild(vertex);
        }
        for (let index = 0; index < meshData.triangles.length; index += 3) {
          const triangle = doc.createElementNS(doc.documentElement.namespaceURI, 'triangle');
          triangle.setAttribute('v1', String(meshData.triangles[index] + vertexOffset));
          triangle.setAttribute('v2', String(meshData.triangles[index + 1] + vertexOffset));
          triangle.setAttribute('v3', String(meshData.triangles[index + 2] + vertexOffset));
          triangles.appendChild(triangle);
        }
        vertexOffset += meshData.vertices.length / 3;
      }
      mesh.appendChild(vertices);
      mesh.appendChild(triangles);
      object.appendChild(mesh);
      resources.appendChild(object);
      existingResourceIds.add(part.objectId);
    }
  }
  for (const part of parts) {
    const transform3mf = partTransform3mf(part);
    const node = template.cloneNode(true) as Element;
    node.setAttribute('objectid', part.objectId);
    node.setAttribute('transform', matrix3mfFromThree(transform3mf));
    if (insertBefore && insertBefore.parentNode === build) build.insertBefore(node, insertBefore);
    else build.appendChild(node);
  }
  zip.file(modelPath, new XMLSerializer().serializeToString(doc));
  return zip.generateAsync({ type: 'blob', mimeType: 'model/3mf' });
}

export function PlateEditorModal({
  libraryFileId,
  filename,
  fileType,
  folderId,
  plateId = null,
  initialModels,
  buildVolume = { x: 256, y: 256, z: 256 },
  onClose,
  onSaved,
}: PlateEditorModalProps) {
  const { showToast } = useToast();
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const partsGroupRef = useRef<THREE.Group | null>(null);
  const sourceBytesRef = useRef<ArrayBuffer | null>(null);
  const parsedRef = useRef<Parsed3MFData | null>(null);
  const dragRef = useRef<{ part: EditablePart; point: THREE.Vector3 } | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [parts, setParts] = useState<EditablePart[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [libraryPickerOpen, setLibraryPickerOpen] = useState(false);
  const [libraryFiles, setLibraryFiles] = useState<LibraryFileListItem[]>([]);
  const [libraryFilesLoading, setLibraryFilesLoading] = useState(false);
  const [librarySelection, setLibrarySelection] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [, setRevision] = useState(0);

  const isStl = (fileType || filename.split('.').pop() || '').toLowerCase() === 'stl';
  const selectedPart = useMemo(() => parts.find((part) => part.key === selectedKey) ?? null, [parts, selectedKey]);

  const pointOnBed = useCallback((event: PointerEvent | MouseEvent): THREE.Vector3 | null => {
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    const container = containerRef.current;
    if (!renderer || !camera || !container) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, camera);
    const ray = raycaster.ray;
    if (Math.abs(ray.direction.y) < 0.0001) return null;
    const distance = -ray.origin.y / ray.direction.y;
    if (distance < 0) return null;
    return ray.origin.clone().addScaledVector(ray.direction, distance);
  }, []);

  const importFiles = async (files: Array<{ name: string; bytes: ArrayBuffer }>) => {
    if (files.length === 0) return;
    try {
      setImporting(true);
      const imported: EditablePart[] = [];
      let currentParts = parts;
      for (const file of files) {
        const next = await importModelBytes(
          file.bytes,
          file.name,
          currentParts,
          parsedRef.current ? parsedRef.current.objects.keys() : [],
          buildVolume,
        );
        imported.push(...next);
        currentParts = [...currentParts, ...next];
      }
      if (imported.length === 0) throw new Error('No printable objects were found in the selected files');
      const nextParts = [...parts, ...imported];
      arrangeEditableParts(nextParts, buildVolume);
      setParts(nextParts);
      setSelectedKey(imported[0].key);
      showToast(`Added ${imported.length} model${imported.length === 1 ? '' : 's'} to the build plate`, 'success');
    } catch (importError) {
      showToast(importError instanceof Error ? importError.message : 'Unable to add the selected model', 'error');
    } finally {
      setImporting(false);
    }
  };

  const openLibraryPicker = async () => {
    setLibraryPickerOpen(true);
    if (libraryFiles.length > 0) return;
    try {
      setLibraryFilesLoading(true);
      const files = await api.getLibraryFiles(undefined, false);
      setLibraryFiles(files.filter((file) => /\.(?:stl|3mf)$/i.test(file.filename) && file.id !== libraryFileId));
    } catch (loadError) {
      showToast(loadError instanceof Error ? loadError.message : 'Unable to load library models', 'error');
    } finally {
      setLibraryFilesLoading(false);
    }
  };

  const addSelectedLibraryModels = async () => {
    if (librarySelection.length === 0) return;
    try {
      setImporting(true);
      const selectedFiles: Array<{ name: string; bytes: ArrayBuffer }> = [];
      for (const fileId of librarySelection) {
        const file = libraryFiles.find((candidate) => candidate.id === fileId);
        if (!file) continue;
        const headers: HeadersInit = {};
        const token = getAuthToken();
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await fetch(api.getLibraryFileDownloadUrl(file.id), { headers, cache: 'no-store' });
        if (!response.ok) throw new Error(`Unable to download ${file.filename}`);
        selectedFiles.push({ name: file.filename, bytes: await response.arrayBuffer() });
      }
      setLibraryPickerOpen(false);
      setLibrarySelection([]);
      await importFiles(selectedFiles);
    } catch (loadError) {
      showToast(loadError instanceof Error ? loadError.message : 'Unable to add library models', 'error');
      setImporting(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        const editorBuildVolume = { x: buildVolume.x, y: buildVolume.y };
        const headers: HeadersInit = {};
        const token = getAuthToken();
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await fetch(api.getLibraryFileDownloadUrl(libraryFileId), { headers, cache: 'no-store' });
        if (!response.ok) throw new Error('Unable to download the model');
        const source = await response.arrayBuffer();
        if (cancelled) return;
        sourceBytesRef.current = source;
        const nextParts: EditablePart[] = [];
        if (isStl) {
          const raw = new STLLoader().parse(source);
          raw.computeVertexNormals();
          const sourceMesh = buildStlMeshData(raw);
          raw.rotateX(-Math.PI / 2);
          const box = new THREE.Box3().setFromBufferAttribute(raw.getAttribute('position') as THREE.BufferAttribute);
          const partData = makePartGroup([{ vertices: Array.from(raw.getAttribute('position').array as ArrayLike<number>), triangles: Array.from({ length: raw.getAttribute('position').count }, (_, index) => index), extruder: 0 }], '1', new THREE.Matrix4(), true);
          // makePartGroup centers the mesh and places the group at its local
          // center. Preserve that center when lifting the STL so its lowest
          // point is at the bed; replacing the group Y position with
          // `-box.min.y` would subtract the center twice and put the model
          // below the plate.
          partData.group.position.set(buildVolume.x / 2, partData.center.y - box.min.y, buildVolume.y / 2);
          nextParts.push({ key: 'part-1', objectId: '1', sourceMeshes: [sourceMesh], sourceFormat: 'stl', label: filename, group: partData.group, meshGroup: partData.meshGroup, center: partData.center, width: partData.width, depth: partData.depth });
        } else {
          const parsed = await parse3MF(source);
          parsedRef.current = parsed;
          const hasPlateAssignments = parsed.buildItems.some((item) => item.plateId != null);
          const sourceItems = plateId != null && hasPlateAssignments
            ? parsed.buildItems.filter((item) => item.plateId === plateId)
            : parsed.buildItems;
          const items: BuildItem[] = sourceItems.length > 0
            ? sourceItems
            : Array.from(parsed.objects.values()).map((object) => ({ objectId: object.id, transform: new THREE.Matrix4(), plateId: null } satisfies BuildItem));
          items.forEach((item, index) => {
            const object = parsed.objects.get(item.objectId);
            if (!object) return;
            const partData = makePartGroup(object.meshes, item.objectId, threeMatrixFrom3mf(item.transform), false);
            nextParts.push({ key: `part-${index + 1}`, objectId: item.objectId, sourceBuildIndex: item.buildIndex, label: filename, group: partData.group, meshGroup: partData.meshGroup, center: partData.center, width: partData.width, depth: partData.depth });
          });
          // 3MF item transforms are allowed to carry the model's original
          // Z-origin. The viewer lifts the complete model group so its lowest
          // point rests on the bed; the editor must do the same or a perfectly
          // valid project can appear hundreds of millimetres below the plate.
          if (nextParts.length > 0) {
            let lowestY = Number.POSITIVE_INFINITY;
            for (const part of nextParts) {
              part.group.updateMatrixWorld(true);
              lowestY = Math.min(lowestY, new THREE.Box3().setFromObject(part.group).min.y);
            }
            if (Number.isFinite(lowestY)) {
              for (const part of nextParts) part.group.position.y -= lowestY;
            }

            // Match the placement used by ModelViewer. Bambu/Orca projects
            // can contain a valid model whose XY origin is outside the bed
            // (some sliced 3MFs have Z values around -68 after the Y/Z
            // conversion). Keep the source layout when it is already on the
            // bed, but bring an unanchored layout onto the bed before editing.
            const modelBox = new THREE.Box3();
            for (const part of nextParts) {
              part.group.updateMatrixWorld(true);
              modelBox.union(new THREE.Box3().setFromObject(part.group));
            }

            let correctionX = 0;
            let correctionZ = 0;
            const inferredPlateId = plateId ?? (
              parsed.plateBounds.size === 1 ? Array.from(parsed.plateBounds.keys())[0] : null
            );
            const selectedPlateBounds = inferredPlateId != null ? parsed.plateBounds.get(inferredPlateId) : undefined;
            const selectedPlateOffset = inferredPlateId != null ? parsed.plateOffsets.get(inferredPlateId) : undefined;
            if (selectedPlateBounds) {
              // plate_*.json stores the printer-space XY bounding box. In
              // Three.js the second value is Z, just as in ModelViewer.
              correctionX = selectedPlateBounds.minX - modelBox.min.x;
              correctionZ = selectedPlateBounds.minY - modelBox.min.z;
            } else if (selectedPlateOffset) {
              correctionX = buildVolume.x / 2 - selectedPlateOffset.offsetX;
              correctionZ = buildVolume.y / 2 - selectedPlateOffset.offsetY;
            } else {
              const fitAxis = (min: number, max: number, size: number): number => {
                // Center a layout that is not already on the bed. This is
                // especially important for sliced files whose coordinate
                // origin is centered on (0, 0), otherwise a negative layout
                // would only be nudged to the nearest edge.
                if (min < 0 || max > size || max - min > size) {
                  return size / 2 - (min + max) / 2;
                }
                return 0;
              };
              correctionX = fitAxis(modelBox.min.x, modelBox.max.x, buildVolume.x);
              correctionZ = fitAxis(modelBox.min.z, modelBox.max.z, buildVolume.y);
            }
            for (const part of nextParts) {
              part.group.position.x += correctionX;
              part.group.position.z += correctionZ;
            }
          }
        }
        // A new build plate can be opened from a multi-selection in the File
        // Manager. The primary file is loaded above; append the remaining
        // selected files before the first render so the user sees the whole
        // plate immediately.
        if (initialModels && initialModels.length > 1) {
          const existingObjectIds = parsedRef.current ? Array.from(parsedRef.current.objects.keys()) : [];
          for (const model of initialModels) {
            if (model.id === libraryFileId) continue;
            const modelHeaders: HeadersInit = {};
            const modelToken = getAuthToken();
            if (modelToken) modelHeaders.Authorization = `Bearer ${modelToken}`;
            const modelResponse = await fetch(api.getLibraryFileDownloadUrl(model.id), { headers: modelHeaders, cache: 'no-store' });
            if (!modelResponse.ok) throw new Error(`Unable to download ${model.filename}`);
            const imported = await importModelBytes(
              await modelResponse.arrayBuffer(),
              model.filename,
              nextParts,
              existingObjectIds,
              editorBuildVolume,
            );
            nextParts.push(...imported);
          }
          arrangeEditableParts(nextParts, editorBuildVolume);
        }
        if (cancelled) return;
        setParts(nextParts);
        setSelectedKey(nextParts[0]?.key ?? null);
        setLoading(false);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Unable to load this model');
          setLoading(false);
        }
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [buildVolume.x, buildVolume.y, fileType, filename, initialModels, isStl, libraryFileId, plateId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || loading || error) return;
    const width = Math.max(container.clientWidth, 320);
    const height = Math.max(container.clientHeight, 320);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x141414);
    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 2000);
    camera.position.set(buildVolume.x * 0.95, buildVolume.z * 1.15, buildVolume.y * 0.95);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(buildVolume.x / 2, 0, buildVolume.y / 2);
    controls.update();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x303030, 2.2));
    const light = new THREE.DirectionalLight(0xffffff, 1.6);
    light.position.set(buildVolume.x / 2, buildVolume.z * 2, buildVolume.y / 2);
    scene.add(light);
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(buildVolume.x, buildVolume.y),
      new THREE.MeshStandardMaterial({ color: 0x225f48, transparent: true, opacity: 0.42, side: THREE.DoubleSide }),
    );
    plate.rotation.x = -Math.PI / 2;
    plate.position.set(buildVolume.x / 2, -0.5, buildVolume.y / 2);
    plate.receiveShadow = true;
    scene.add(plate);
    const grid = new THREE.GridHelper(Math.max(buildVolume.x, buildVolume.y), Math.ceil(Math.max(buildVolume.x, buildVolume.y) / 16), 0x5a8f75, 0x315645);
    grid.position.set(buildVolume.x / 2, -0.48, buildVolume.y / 2);
    scene.add(grid);
    const partsGroup = new THREE.Group();
    scene.add(partsGroup);
    for (const part of parts) partsGroup.add(part.group);
    sceneRef.current = scene;
    cameraRef.current = camera;
    rendererRef.current = renderer;
    controlsRef.current = controls;
    partsGroupRef.current = partsGroup;
    const raycaster = new THREE.Raycaster();
    const onPointerDown = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(partsGroup.children, true)[0];
      if (!hit) return;
      const part = parts.find((candidate) => candidate.group === hit.object.parent || candidate.group === hit.object.parent?.parent);
      if (!part) return;
      const point = pointOnBed(event);
      if (!point) return;
      setSelectedKey(part.key);
      dragRef.current = { part, point };
      controls.enabled = false;
      renderer.domElement.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const point = pointOnBed(event);
      if (!point) return;
      drag.part.group.position.x += point.x - drag.point.x;
      drag.part.group.position.z += point.z - drag.point.z;
      drag.point = point;
      setRevision((value) => value + 1);
    };
    const onPointerUp = (event: PointerEvent) => {
      dragRef.current = null;
      controls.enabled = true;
      if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId);
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    let animation = 0;
    const animate = () => { animation = requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); };
    animate();
    const resize = () => { const w = container.clientWidth; const h = container.clientHeight; camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h); };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => {
      cancelAnimationFrame(animation);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      controls.dispose();
      renderer.dispose();
      container.removeChild(renderer.domElement);
      partsGroup.clear();
      scene.clear();
    };
  }, [buildVolume, error, loading, parts, pointOnBed]);

  const rotatePart = (axis: 'x' | 'y' | 'z', amount: number) => {
    if (!selectedPart) return;
    selectedPart.group.rotation[axis] += THREE.MathUtils.degToRad(amount);
    setRevision((value) => value + 1);
  };

  const duplicatePart = () => {
    if (!selectedPart) return;
    const clone = selectedPart.group.clone(true);
    clone.position.x += Math.max(selectedPart.width, 10) + 5;
    clone.userData.objectId = selectedPart.objectId;
    const copy: EditablePart = { ...selectedPart, key: `part-${Date.now()}`, group: clone, meshGroup: clone.children[0] as THREE.Group };
    setParts((current) => [...current, copy]);
    setSelectedKey(copy.key);
  };

  const deletePart = () => {
    if (!selectedPart) return;
    setParts((current) => current.filter((part) => part.key !== selectedPart.key));
    setSelectedKey(parts.find((part) => part.key !== selectedPart.key)?.key ?? null);
  };

  const arrangeParts = () => {
    arrangeEditableParts(parts, buildVolume);
    setRevision((value) => value + 1);
  };

  const outOfBounds = parts.filter((part) => {
    part.group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(part.group);
    return box.min.x < 0 || box.max.x > buildVolume.x || box.min.z < 0 || box.max.z > buildVolume.y || box.min.y < -0.2;
  }).length;

  const save = async () => {
    if (!sourceBytesRef.current || parts.length === 0) return;
    try {
      setSaving(true);
      const edited = isStl
        ? await makeStandalone3mf(parts)
        : await makeEdited3mf(sourceBytesRef.current, parts, parsedRef.current!, plateId);
      const base = filename.replace(/\.(?:stl|3mf)$/i, '');
      const upload = await api.uploadLibraryFile(new File([edited], `${base}-layout.3mf`, { type: 'model/3mf' }), folderId, true);
      showToast('Edited plate saved to Bambuddy', 'success');
      onSaved(upload);
    } catch (saveError) {
      showToast(saveError instanceof Error ? saveError.message : 'Unable to save the edited plate', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4" onClick={onClose}>
      <div className="relative bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-xl w-full max-w-7xl h-[92vh] flex flex-col overflow-hidden" onClick={(event) => event.stopPropagation()}>
          <div className="flex items-center justify-between gap-4 px-5 py-3 border-b border-bambu-dark-tertiary">
          <div className="min-w-0"><h2 className="text-lg font-semibold text-white truncate">Edit build plate</h2><p className="text-xs text-bambu-gray truncate">{filename} · drag parts to move them</p></div>
          <div className="flex items-center gap-2">
            <input
              ref={importInputRef}
              type="file"
              accept=".stl,.3mf,model/stl,model/3mf"
              multiple
              className="hidden"
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = '';
                void Promise.all(files.map(async (file) => ({ name: file.name, bytes: await file.arrayBuffer() })))
                  .then((selected) => importFiles(selected));
              }}
            />
            <Button variant="secondary" size="sm" onClick={() => importInputRef.current?.click()} disabled={loading || importing}>
              {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <FilePlus2 className="w-4 h-4" />}Add models
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void openLibraryPicker()} disabled={loading || importing}>
              <Plus className="w-4 h-4" />From library
            </Button>
            <Button variant="secondary" size="sm" onClick={arrangeParts}><WandSparkles className="w-4 h-4" />Auto arrange</Button>
            <Button variant="primary" size="sm" onClick={() => void save()} disabled={saving || loading || !!error || parts.length === 0}>{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Box className="w-4 h-4" />}{saving ? 'Saving…' : 'Save layout & slice'}</Button>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close"><X className="w-5 h-5" /></Button>
          </div>
        </div>
        <div className="flex-1 min-h-0 flex">
          <div className="flex-1 min-w-0 relative"><div ref={containerRef} className="absolute inset-0" />{(loading || error) && <div className="absolute inset-0 flex items-center justify-center bg-bambu-dark/60">{loading ? <Loader2 className="w-8 h-8 animate-spin text-bambu-green" /> : <p className="text-red-300 text-sm px-6 text-center">{error}</p>}</div>}</div>
          <aside className="w-72 shrink-0 border-l border-bambu-dark-tertiary bg-bambu-dark p-4 overflow-y-auto">
            <div className="flex items-center gap-2 text-sm text-white font-medium mb-3"><Grid3X3 className="w-4 h-4 text-bambu-green" />Parts ({parts.length})</div>
            <div className="space-y-2 mb-5">{parts.map((part, index) => <button key={part.key} type="button" onClick={() => setSelectedKey(part.key)} className={`w-full text-left rounded-lg border px-3 py-2 text-sm ${part.key === selectedKey ? 'border-bambu-green bg-bambu-green/10 text-white' : 'border-bambu-dark-tertiary text-bambu-gray hover:text-white'}`}><span>{part.label || `Part ${index + 1}`}</span><span className="block text-xs text-bambu-gray">{part.width.toFixed(1)} × {part.depth.toFixed(1)} mm</span></button>)}</div>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" size="sm" onClick={duplicatePart} disabled={!selectedPart}><Copy className="w-4 h-4" />Duplicate</Button>
              <Button variant="secondary" size="sm" onClick={deletePart} disabled={!selectedPart || parts.length < 2}><Trash2 className="w-4 h-4" />Delete</Button>
            </div>
            <div className="mt-5 border-t border-bambu-dark-tertiary pt-4"><p className="text-xs uppercase tracking-wide text-bambu-gray mb-2">Rotate selected</p><div className="grid grid-cols-3 gap-2"><Button variant="secondary" size="sm" onClick={() => rotatePart('x', 90)} disabled={!selectedPart}>X +90°</Button><Button variant="secondary" size="sm" onClick={() => rotatePart('y', 90)} disabled={!selectedPart}><RotateCw className="w-3.5 h-3.5" />Y +90°</Button><Button variant="secondary" size="sm" onClick={() => rotatePart('z', 90)} disabled={!selectedPart}>Z +90°</Button></div></div>
            <div className={`mt-5 rounded-lg border p-3 text-xs ${outOfBounds ? 'border-amber-500/60 bg-amber-500/10 text-amber-200' : 'border-bambu-dark-tertiary text-bambu-gray'}`}><div className="flex items-center gap-2"><Move className="w-4 h-4" />{outOfBounds ? `${outOfBounds} part${outOfBounds === 1 ? '' : 's'} outside the plate` : 'All parts are inside the plate'}</div><p className="mt-2">Build volume: {buildVolume.x} × {buildVolume.y} mm</p></div>
            <p className="mt-5 text-xs text-bambu-gray">Add STL or 3MF files from your computer or library, then drag, rotate, duplicate, or auto-arrange them. Your original file stays unchanged.</p>
          </aside>
        </div>
        {libraryPickerOpen && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/70 p-6">
            <div className="w-full max-w-xl max-h-[75vh] rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-5 shadow-2xl">
              <div className="flex items-center justify-between gap-3 mb-4">
                <div><h3 className="text-lg font-semibold text-white">Add models from library</h3><p className="text-xs text-bambu-gray">Select one or more STL or 3MF files.</p></div>
                <Button variant="ghost" size="sm" onClick={() => setLibraryPickerOpen(false)} aria-label="Close library picker"><X className="w-5 h-5" /></Button>
              </div>
              <div className="max-h-[48vh] overflow-y-auto space-y-2">
                {libraryFilesLoading && <div className="flex items-center justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-bambu-green" /></div>}
                {!libraryFilesLoading && libraryFiles.length === 0 && <p className="py-8 text-center text-sm text-bambu-gray">No other STL or 3MF files are available.</p>}
                {!libraryFilesLoading && libraryFiles.map((file) => {
                  const selected = librarySelection.includes(file.id);
                  return <label key={file.id} className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 ${selected ? 'border-bambu-green bg-bambu-green/10' : 'border-bambu-dark-tertiary'}`}>
                    <input type="checkbox" checked={selected} onChange={() => setLibrarySelection((current) => selected ? current.filter((id) => id !== file.id) : [...current, file.id])} />
                    <span className="min-w-0 text-sm text-white truncate">{file.print_name || file.filename}</span>
                  </label>;
                })}
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={() => setLibraryPickerOpen(false)}>Cancel</Button>
                <Button variant="primary" size="sm" onClick={() => void addSelectedLibraryModels()} disabled={librarySelection.length === 0 || importing}><Plus className="w-4 h-4" />Add selected</Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
