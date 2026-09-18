/* 付録Aを基準に収録。未記載の相談時間は推測しない。 */
(function(root){
  'use strict';
  const centers = [
  {
    "name": "神川",
    "address": "上田市国分533-20",
    "area": "東部地区、神川地区",
    "phone": "0268-29-2266",
    "hours": "月〜金 8:30〜17:15"
  },
  {
    "name": "中央",
    "address": "上田市中央1-3-3 上田病院複合施設1階",
    "area": "南部地区、中央地区、北部地区",
    "phone": "0268-26-7788",
    "hours": "月〜金 9:00〜18:00"
  },
  {
    "name": "西部",
    "address": "上田市常磐城2256-1",
    "area": "西部地区、塩尻地区",
    "phone": "0268-71-5712",
    "hours": "月〜金 8:30〜17:30"
  },
  {
    "name": "城下",
    "address": "上田市御所番外53-122",
    "area": "城下地区、川辺地区、泉田地区（半過・下之条・川辺町）",
    "phone": "0268-22-2360",
    "hours": "月〜土 8:30〜17:30"
  },
  {
    "name": "神科",
    "address": "上田市住吉322",
    "area": "神科地区、豊殿地区",
    "phone": "0268-27-2881",
    "hours": "月〜金 8:30〜18:00／土 8:30〜12:30"
  },
  {
    "name": "塩田",
    "address": "上田市中野29-2",
    "area": "塩田地区",
    "phone": "0268-37-1537",
    "hours": "月〜金 8:40〜17:30"
  },
  {
    "name": "川西",
    "address": "上田市小泉769-3",
    "area": "川西地区、川辺地区、泉田地区（半過・下之条・川辺町以外）",
    "phone": "0268-26-1172",
    "hours": "月〜金 8:30〜17:15"
  },
  {
    "name": "丸子",
    "address": "上田市上丸子1600-1",
    "area": "丸子地域（東内・西内・腰越以外）",
    "phone": "0268-42-0015",
    "hours": null
  },
  {
    "name": "真田",
    "address": "上田市真田町長7190",
    "area": "真田地域",
    "phone": "0268-72-8055",
    "hours": null
  },
  {
    "name": "武石",
    "address": "上田市下武石742",
    "area": "武石地域、丸子地域（東内・西内・腰越）",
    "phone": "0268-41-4055",
    "hours": null
  }
];
  const data=Object.freeze({source:'https://www.city.ueda.nagano.jp/soshiki/korei/2610.html',checkedAt:'2026-09-18',centers:Object.freeze(centers.map(Object.freeze))});
  if(typeof module==='object'&&module.exports)module.exports=data;
  root.MainicoUedaCenters=data;
})(typeof window!=='undefined'?window:globalThis);
