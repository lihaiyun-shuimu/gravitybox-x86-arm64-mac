import {createHash} from 'node:crypto';
import { bt } from './i18n.js';
/** One candidate format for resource, visible UI and explicitly selected plugin copy. */
export const UI_KINDS = new Set(['button','tab','menuitem','tooltip','heading','label','option','toast','placeholder','attribute','description','template']);
export type PendingItem = {key:string;kind?:string;route?:string;source?:'static'|'runtime-ui'|'plugin';translationKey?:string};
export function safeRoute(value:unknown):string {
  if(typeof value!=='string')return '/other';
  if(value==='/fixture')return value;
  if(/^\/customizations(?:\/installed)?$/.test(value))return value;
  if(/^\/settings(?:\/[a-z-]+)?$/.test(value)||value==='/settings-standalone')return '/settings';
  return ['/','/history','/sidecars','/automations'].includes(value)?value:'/other';
}
export function scopedKey(key:string,kind:string,route:string){return `@ui:${safeRoute(route)}|${UI_KINDS.has(kind)?kind:'label'}|${key}`;}
export function decodeScopedKey(value:string){const match=value.match(/^@ui:([^|]+)\|([^|]+)\|([\s\S]+)$/);return match&&safeRoute(match[1])===match[1]&&UI_KINDS.has(match[2]!)?{key:match[3]!,kind:match[2]!,route:match[1]!}:undefined;}
export function pendingIdentity(item:PendingItem){return item.translationKey??item.key;}

export function describeContext(scope:{route:string;kind:string}){
  const routeKeys:Record<string,string>={'/':'candidate.route.home','/settings':'candidate.route.settings','/history':'candidate.route.history','/customizations':'candidate.route.customizations','/customizations/installed':'candidate.route.installed','/sidecars':'candidate.route.automations','/automations':'candidate.route.automations','/other':'candidate.route.other','/fixture':'candidate.route.fixture'};
  const kindKeys:Record<string,string>={button:'candidate.kind.button',heading:'candidate.kind.heading',tooltip:'candidate.kind.tooltip',placeholder:'candidate.kind.placeholder',menuitem:'candidate.kind.menuitem',tab:'candidate.kind.tab',label:'candidate.kind.label',description:'candidate.kind.description',attribute:'candidate.kind.attribute',option:'candidate.kind.option',toast:'candidate.kind.toast',template:'candidate.kind.template'};
  return `${bt(routeKeys[scope.route]??'candidate.route.default')} · ${bt(kindKeys[scope.kind]??'candidate.kind.default')}`;
}

export function previewItemId(item:PendingItem){return createHash('sha256').update(pendingIdentity(item)).digest('hex');}
export function selectedPreviewItems(entries:PendingItem[], ids:unknown):PendingItem[]{
  if(ids===undefined)return entries;
  if(!Array.isArray(ids)||ids.length===0||ids.length>entries.length||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)throw new Error(bt('candidate.err.invalid_subset'));
  const allowed=new Set(entries.map(previewItemId));if(ids.some(id=>!allowed.has(id)))throw new Error(bt('candidate.err.not_in_preview'));
  const selected=new Set(ids);return entries.filter(item=>selected.has(previewItemId(item)));
}
