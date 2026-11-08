import { strToU8, zipSync } from 'fflate';
import { bakeMesh, type PlacedMesh } from '../geometry/meshData';

export interface ColoredPlacedMesh extends PlacedMesh {
  name: string;
  /** #rrggbb */
  color: string;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Trim float noise: 6 decimals is 1 nm at mm scale. */
function num(v: number): string {
  return String(Math.round(v * 1e6) / 1e6);
}

/** Build the 3D/3dmodel.model XML: one object per item, colour via basematerials. */
export function build3mfModel(items: ColoredPlacedMesh[]): string {
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
  );
  out.push('<metadata name="Application">3D Open Builder</metadata>');
  out.push('<resources>');
  out.push('<basematerials id="1">');
  for (const item of items) {
    out.push(`<base name="${escapeXml(item.name)}" displaycolor="${item.color.toUpperCase()}FF"/>`);
  }
  out.push('</basematerials>');
  items.forEach((item, index) => {
    const { positions: p, indices } = bakeMesh(item);
    out.push(
      `<object id="${index + 2}" type="model" name="${escapeXml(item.name)}" pid="1" pindex="${index}"><mesh><vertices>`,
    );
    for (let i = 0; i < p.length; i += 3) {
      out.push(`<vertex x="${num(p[i])}" y="${num(p[i + 1])}" z="${num(p[i + 2])}"/>`);
    }
    out.push('</vertices><triangles>');
    for (let i = 0; i < indices.length; i += 3) {
      out.push(`<triangle v1="${indices[i]}" v2="${indices[i + 1]}" v3="${indices[i + 2]}"/>`);
    }
    out.push('</triangles></mesh></object>');
  });
  out.push('</resources>');
  out.push('<build>');
  items.forEach((_, index) => out.push(`<item objectid="${index + 2}"/>`));
  out.push('</build>');
  out.push('</model>');
  return out.join('\n');
}

/** 3MF is a zip (OPC package) holding the model XML plus two small index files. */
export function export3mf(items: ColoredPlacedMesh[]): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(RELS),
    '3D/3dmodel.model': strToU8(build3mfModel(items)),
  });
}
