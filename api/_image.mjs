const PNG_SIGNATURE=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
const MIN_SIDE=320;
const MAX_SIDE=5000;
const MAX_PIXELS=16_000_000;

const CRC_TABLE=new Uint32Array(256);
for(let value=0;value<256;value++) {
  let crc=value;
  for(let bit=0;bit<8;bit++)crc=(crc&1)?0xedb88320^(crc>>>1):crc>>>1;
  CRC_TABLE[value]=crc>>>0;
}

function uploadError(message,code,status=415) {
  return Object.assign(new Error(message),{code,status});
}

function crc32(bytes,start,end) {
  let crc=0xffffffff;
  for(let index=start;index<end;index++)crc=CRC_TABLE[(crc^bytes[index])&0xff]^(crc>>>8);
  return (crc^0xffffffff)>>>0;
}

function pngMetadata(bytes) {
  if(bytes.length<45||!bytes.subarray(0,8).equals(PNG_SIGNATURE))return null;
  let offset=8,width=null,height=null,seenIdat=false,seenIend=false,chunkIndex=0;
  while(offset<bytes.length) {
    if(offset+12>bytes.length)throw uploadError('Fichier PNG tronqué.','invalid_image_bytes');
    const length=bytes.readUInt32BE(offset),typeStart=offset+4,dataStart=offset+8,dataEnd=dataStart+length,chunkEnd=dataEnd+4;
    if(length>bytes.length||chunkEnd>bytes.length)throw uploadError('Fichier PNG tronqué.','invalid_image_bytes');
    const type=bytes.toString('ascii',typeStart,dataStart);
    if(!/^[A-Za-z]{4}$/.test(type)||crc32(bytes,typeStart,dataEnd)!==bytes.readUInt32BE(dataEnd))
      throw uploadError('Structure PNG invalide.','invalid_image_bytes');
    if(chunkIndex===0&&type!=='IHDR')throw uploadError('En-tête PNG invalide.','invalid_image_bytes');
    if(type==='IHDR') {
      if(chunkIndex!==0||length!==13||width!==null)throw uploadError('En-tête PNG invalide.','invalid_image_bytes');
      width=bytes.readUInt32BE(dataStart);height=bytes.readUInt32BE(dataStart+4);
      const depth=bytes[dataStart+8],colour=bytes[dataStart+9],compression=bytes[dataStart+10],filter=bytes[dataStart+11],interlace=bytes[dataStart+12];
      const depths={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
      if(!depths[colour]?.includes(depth)||compression!==0||filter!==0||![0,1].includes(interlace))
        throw uploadError('Paramètres PNG non pris en charge.','invalid_image_bytes');
    } else if(type==='IDAT')seenIdat=true;
    else if(type==='IEND') {
      if(length!==0||!seenIdat||chunkEnd!==bytes.length)throw uploadError('Fin PNG invalide.','invalid_image_bytes');
      seenIend=true;
    }
    if(seenIend)break;
    offset=chunkEnd;chunkIndex+=1;
  }
  if(!seenIend||width===null||height===null)throw uploadError('Fichier PNG incomplet.','invalid_image_bytes');
  return {contentType:'image/png',extension:'png',width,height};
}

const JPEG_SOF=new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);

function jpegMetadata(bytes) {
  if(bytes.length<16||bytes[0]!==0xff||bytes[1]!==0xd8)return null;
  if(bytes.at(-2)!==0xff||bytes.at(-1)!==0xd9)throw uploadError('Fin JPEG invalide.','invalid_image_bytes');
  let offset=2,width=null,height=null,seenScan=false;
  while(offset<bytes.length-2) {
    if(bytes[offset++]!==0xff)throw uploadError('Structure JPEG invalide.','invalid_image_bytes');
    while(offset<bytes.length&&bytes[offset]===0xff)offset+=1;
    if(offset>=bytes.length)throw uploadError('Fichier JPEG tronqué.','invalid_image_bytes');
    const marker=bytes[offset++];
    if(marker===0xd9)break;
    if(marker===0xd8||marker===0x00)throw uploadError('Marqueur JPEG invalide.','invalid_image_bytes');
    if(marker===0x01||marker>=0xd0&&marker<=0xd7)continue;
    if(offset+2>bytes.length)throw uploadError('Fichier JPEG tronqué.','invalid_image_bytes');
    const length=bytes.readUInt16BE(offset),segmentEnd=offset+length;
    if(length<2||segmentEnd>bytes.length)throw uploadError('Segment JPEG invalide.','invalid_image_bytes');
    if(JPEG_SOF.has(marker)) {
      if(length<8)throw uploadError('Dimensions JPEG invalides.','invalid_image_bytes');
      height=bytes.readUInt16BE(offset+3);width=bytes.readUInt16BE(offset+5);
      const components=bytes[offset+7];
      if(components<1||components>4||length!==8+3*components)throw uploadError('Composantes JPEG invalides.','invalid_image_bytes');
    }
    if(marker===0xda){seenScan=true;break;}
    offset=segmentEnd;
  }
  if(!seenScan||width===null||height===null)throw uploadError('Fichier JPEG incomplet.','invalid_image_bytes');
  return {contentType:'image/jpeg',extension:'jpg',width,height};
}

function uint24LE(bytes,offset) {return bytes[offset]|bytes[offset+1]<<8|bytes[offset+2]<<16;}

function webpMetadata(bytes) {
  if(bytes.length<30||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WEBP')return null;
  if(bytes.readUInt32LE(4)!==bytes.length-8)throw uploadError('Taille WebP invalide.','invalid_image_bytes');
  let offset=12,canvas=null,frame=null,seenImage=false;
  while(offset<bytes.length) {
    if(offset+8>bytes.length)throw uploadError('Fichier WebP tronqué.','invalid_image_bytes');
    const type=bytes.toString('ascii',offset,offset+4),length=bytes.readUInt32LE(offset+4),dataStart=offset+8,dataEnd=dataStart+length,paddedEnd=dataEnd+(length&1);
    if(dataEnd>bytes.length||paddedEnd>bytes.length)throw uploadError('Bloc WebP invalide.','invalid_image_bytes');
    if(type==='VP8X') {
      if(length!==10||canvas)throw uploadError('En-tête WebP invalide.','invalid_image_bytes');
      const flags=bytes[dataStart];
      if((flags&0xc3)!==0)throw uploadError('WebP animé ou réservé non pris en charge.','invalid_image_bytes');
      canvas={width:uint24LE(bytes,dataStart+4)+1,height:uint24LE(bytes,dataStart+7)+1};
    } else if(type==='VP8 ') {
      if(seenImage||length<10||bytes[dataStart]&1||bytes[dataStart+3]!==0x9d||bytes[dataStart+4]!==0x01||bytes[dataStart+5]!==0x2a)
        throw uploadError('Image WebP VP8 invalide.','invalid_image_bytes');
      frame={width:bytes.readUInt16LE(dataStart+6)&0x3fff,height:bytes.readUInt16LE(dataStart+8)&0x3fff};seenImage=true;
    } else if(type==='VP8L') {
      if(seenImage||length<5||bytes[dataStart]!==0x2f||bytes[dataStart+4]>>5!==0)
        throw uploadError('Image WebP sans perte invalide.','invalid_image_bytes');
      frame={width:1+(bytes[dataStart+1]|(bytes[dataStart+2]&0x3f)<<8),height:1+((bytes[dataStart+2]>>6)|bytes[dataStart+3]<<2|(bytes[dataStart+4]&0x0f)<<10)};seenImage=true;
    }
    offset=paddedEnd;
  }
  if(offset!==bytes.length||!seenImage)throw uploadError('Fichier WebP incomplet.','invalid_image_bytes');
  if(canvas&&(canvas.width!==frame.width||canvas.height!==frame.height))throw uploadError('Dimensions WebP incohérentes.','invalid_image_bytes');
  const dimensions=canvas||frame;
  return {contentType:'image/webp',extension:'webp',...dimensions};
}

export function inspectUploadedImage(value,declaredContentType) {
  const bytes=Buffer.isBuffer(value)?value:Buffer.from(value||[]);
  const declared=String(declaredContentType||'').split(';')[0].trim().toLowerCase();
  if(!['image/jpeg','image/png','image/webp'].includes(declared))
    throw uploadError('Photo JPEG, PNG ou WebP attendue.','unsupported_image_type');
  const metadata=pngMetadata(bytes)||jpegMetadata(bytes)||webpMetadata(bytes);
  if(!metadata)throw uploadError('Les octets ne correspondent pas à une image JPEG, PNG ou WebP.','invalid_image_bytes');
  if(metadata.contentType!==declared)throw uploadError('Le type annoncé ne correspond pas au fichier image.','image_type_mismatch');
  const {width,height}=metadata,pixels=width*height;
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<MIN_SIDE||height<MIN_SIDE||width>MAX_SIDE||height>MAX_SIDE||pixels>MAX_PIXELS)
    throw uploadError(`Dimensions attendues : ${MIN_SIDE} à ${MAX_SIDE} px par côté, ${MAX_PIXELS.toLocaleString('fr-FR')} pixels maximum.`,'invalid_image_dimensions',422);
  return metadata;
}

export const __test={pngMetadata,jpegMetadata,webpMetadata,crc32,MIN_SIDE,MAX_SIDE,MAX_PIXELS};
