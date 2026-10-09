#!/usr/bin/env python3
"""Offline localization on final render pixels, without paid services or manual anchors.

Input JSON (path or '-'): image_path, products[{candidate_key,catalog_id,
variant_id,role,product_name,reference_path}]. Output JSON: normalized hotspots,
omission diagnostics and model/algorithm provenance. A category localization is
never a certification of commercial SKU fidelity. Unknown or ambiguous matches
are omitted rather than inventing coordinates.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import time
import unicodedata

# Must be set before importing transformers: inference cannot download anything.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "data/local-vision"
ALGORITHM = "grounded-sam-interior-point-v1"
ROLE_QUERIES = {
    "sofa": "sofa", "armchair": "armchair", "coffee_table": "coffee table",
    "tv_support": "tv cabinet", "tv_stand": "tv cabinet", "tv_unit": "tv cabinet", "rug": "rug",
    "floor_lamp": "floor lamp", "table_lamp": "table lamp", "lighting": "lamp",
    "pendant_light": "pendant lamp", "pendant": "pendant lamp", "ceiling_light": "ceiling lamp", "ceiling_lamp": "ceiling lamp",
    "wall_light": "wall lamp", "wall_lamp": "wall lamp", "wall_art": "framed painting", "artwork": "framed painting",
    "plant": "potted plant", "plants": "potted plant", "floor_finish": "floor",
    "wall_finish": "wall", "dining_table": "dining table", "dining_chair": "dining chair",
    "dining_chairs": "dining chair", "side_table": "side table", "console": "console table",
    "sideboard": "sideboard", "storage": "cabinet", "bookcase": "bookshelf",
    "curtains": "curtain", "curtain": "curtain", "mirror": "mirror", "vase": "vase",
    "cushion": "cushion", "throw": "blanket", "basket": "basket", "ottoman": "ottoman", "pouf": "ottoman", "planter": "plant pot",
}
SURFACES = {"floor_finish", "wall_finish"}
THRESHOLD = 0.25
MASK_THRESHOLD = 0.70

def ascii_text(value):
    return "".join(c for c in unicodedata.normalize("NFKD", str(value or "")).lower() if not unicodedata.combining(c))

def query_for_product(product):
    role = product.get("role", "")
    name = ascii_text(product.get("product_name", product.get("name", "")))
    # Generic decorative objects remain intentionally unsupported, but a named
    # concrete typology may be grounded safely on final pixels. This supplies a
    # point for the selected object without claiming SKU fidelity.
    if role == "decorative_object" and "elephant" in name and any(token in name for token in ("statuette", "figurine", "statue")):
        return "elephant figurine"
    if role in ROLE_QUERIES:
        query = ROLE_QUERIES[role]
        # Decorative families must be grounded using their actual named typology.
        if role in {"wall_art", "artwork"} and "miroir" in name:
            return "mirror"
        if role in {"wall_art", "artwork"} and any(token in name for token in ("branchage", "branche", "feuille", "metal", "acier")):
            return "metal wall decoration"
        if role in {"lighting", "lamp"}:
            if "lampadaire" in name: return "floor lamp"
            if "suspension" in name: return "pendant lamp"
            if "applique" in name: return "wall lamp"
            if "poser" in name: return "table lamp"
        return query
    for french, query in [("lampadaire", "floor lamp"), ("suspension", "pendant lamp"),
                          ("applique", "wall lamp"), ("miroir", "mirror"), ("rideau", "curtain"),
                          ("coussin", "cushion"), ("plaid", "blanket"), ("vase", "vase"),
                          ("plante", "potted plant"), ("tableau", "framed painting"),
                          ("toile", "framed painting"), ("fauteuil", "armchair"),
                          ("canape", "sofa"), ("tapis", "rug"), ("etagere", "bookshelf")]:
        if french in name:
            return query
    return None

def box_iou(a, b):
    inter = max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    union = max(0.0, a[2]-a[0])*max(0.0,a[3]-a[1]) + max(0.0,b[2]-b[0])*max(0.0,b[3]-b[1]) - inter
    return inter / union if union else 0.0

def valid_product_identity(product):
    return (all(isinstance(product.get(key), str) and product[key] for key in ["candidate_key", "catalog_id", "role"])
            and (product.get("variant_id") is None or isinstance(product["variant_id"], str)))

def interior_point(mask, obstacles=None):
    """Return a pixel strictly inside the actual predicted mask, away from its edge.

    Objects occluding a rug/floor/wall are excluded before the distance transform.
    No positional prior from an original photo or generated placement is used.
    """
    import numpy as np
    from scipy.ndimage import distance_transform_edt, label, binary_dilation
    visible = np.array(mask, dtype=bool, copy=True)
    if obstacles is not None:
        visible &= ~binary_dilation(obstacles, iterations=3)
    # Treat image edges as boundaries so a margin-touching region cannot select
    # a point outside the visible photograph.
    components, count = label(visible)
    if not count: return None
    sizes = np.bincount(components.ravel()); sizes[0] = 0
    component = components == int(sizes.argmax())
    if component.sum() < 25: return None
    distance = distance_transform_edt(np.pad(component, 1))[1:-1, 1:-1]
    y, x = np.unravel_index(distance.argmax(), distance.shape)
    if distance[y,x] < 3: return None
    return int(x), int(y), round(float(distance[y,x]), 3), int(component.sum())

def verify_models():
    manifest_path = ASSETS / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    for entry in manifest["models"]:
        directory = ASSETS / entry["directory"]
        for record in entry["files"]:
            path = directory / record["path"]
            if path.stat().st_size != record["bytes"] or hashlib.file_digest(path.open("rb"), "sha256").hexdigest() != record["sha256"]:
                raise ValueError("Local vision model integrity mismatch")
    return manifest

def locate(payload, device_arg="auto", debug_path=None):
    start = time.monotonic()
    import numpy as np
    import torch
    from PIL import Image
    from transformers import AutoProcessor, AutoModelForZeroShotObjectDetection, SamModel, SamProcessor
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    manifest = verify_models()
    device = "mps" if device_arg == "auto" and torch.backends.mps.is_available() else "cpu" if device_arg == "auto" else device_arg
    image_path = Path(payload["image_path"])
    image_sha = hashlib.file_digest(image_path.open("rb"), "sha256").hexdigest()
    if payload.get("image_sha256") is not None and payload["image_sha256"] != image_sha:
        raise ValueError("Final render identity mismatch")
    image = Image.open(image_path).convert("RGB")
    width, height = image.size
    if width * height > 25_000_000: raise ValueError("Final render too large for local vision")
    products = payload["products"]
    if not isinstance(products, list) or len(products) > 30: raise ValueError("Invalid product list")
    queries, diagnostics = {}, []
    for product in products:
        if not valid_product_identity(product):
            raise ValueError("Invalid frozen product identity")
        if product["catalog_id"].startswith("GENERATED_") or product["candidate_key"].startswith("GENERATED_"):
            continue
        query = query_for_product(product)
        if query is None:
            diagnostics.append({"candidate_key": product["candidate_key"], "reason": "unsupported_visual_typology"})
        else:
            queries.setdefault(query, []).append(product)
    if not queries:
        return {"schema_version": "local-product-locator.result.v1", "image_sha256": image_sha, "hotspots": [], "diagnostics": diagnostics, "paid_api_calls": 0}
    processor = AutoProcessor.from_pretrained(ASSETS / "grounding-dino-tiny", local_files_only=True)
    model = AutoModelForZeroShotObjectDetection.from_pretrained(ASSETS / "grounding-dino-tiny", local_files_only=True).to(device).eval()
    # These excluded objects improve surface occlusion handling but never become
    # purchasable products or extra points.
    all_queries = list(queries) + [q for q in ["television", "window", "door", "radiator"] if q not in queries]
    detections = {}
    for offset in range(0, len(all_queries), 15):
        batch_queries = all_queries[offset:offset+15]
        text = ". ".join(batch_queries) + "."
        inputs = processor(images=image, text=text, return_tensors="pt").to(device)
        with torch.inference_mode(): outputs = model(**inputs)
        logits = outputs.logits[0].sigmoid().cpu().numpy()
        predicted = outputs.pred_boxes[0].cpu().numpy()
        tokens = processor.tokenizer(text, return_offsets_mapping=True)
        char_offset = 0
        for query in batch_queries:
            end = char_offset + len(query)
            token_indexes = [i for i, (lo, hi) in enumerate(tokens["offset_mapping"]) if hi > char_offset and lo < end and hi > lo]
            # The head noun must carry most evidence. Grounding DINO often
            # recognizes a "table" with a low probability for "coffee" even
            # when the correct low table is clearly present. Giving the
            # modifier equal weight would silently omit it. Conversely a
            # "floor lamp" cannot be inferred from a floor response alone.
            noun_start = end - len(query.split()[-1])
            noun_indexes = [i for i,(lo,hi) in enumerate(tokens["offset_mapping"]) if hi > noun_start and lo < end and hi > lo]
            noun_scores = logits[:, noun_indexes].mean(axis=1)
            modifier_indexes = [i for i in token_indexes if i not in noun_indexes]
            scores = (0.75*noun_scores + 0.25*logits[:,modifier_indexes].mean(axis=1)) if modifier_indexes else noun_scores
            order = np.argsort(scores)[::-1]
            chosen = []
            for index in order:
                score = float(scores[index])
                if score < THRESHOLD: break
                cx, cy, bw, bh = predicted[index]
                box = [float(max(0,(cx-bw/2)*width)), float(max(0,(cy-bh/2)*height)), float(min(width,(cx+bw/2)*width)), float(min(height,(cy+bh/2)*height))]
                if box[2]-box[0] < 6 or box[3]-box[1] < 6: continue
                if any(box_iou(box, previous["bbox"]) > 0.50 for previous in chosen): continue
                chosen.append({"bbox": box, "score": score, "query": query})
                if len(chosen) >= 5: break
            detections[query] = chosen
            char_offset = end + 2
    # The detector's learned vocabulary may prefer "low table" to "coffee
    # table". A targeted local pass supplies these equivalent visual names;
    # this is pixel inference only, never another selection/render API call.
    # An ordinary dining table response alone is deliberately insufficient.
    if "coffee table" in queries and not detections.get("coffee table"):
        alias_text = "coffee table. low table. wooden table."
        alias_inputs = processor(images=image,text=alias_text,return_tensors="pt").to(device)
        with torch.inference_mode(): alias_outputs = model(**alias_inputs)
        alias_result = processor.post_process_grounded_object_detection(alias_outputs,alias_inputs.input_ids,
                       threshold=THRESHOLD,text_threshold=THRESHOLD,target_sizes=[(height,width)])[0]
        alternative = []
        for box,score,text_label in zip(alias_result["boxes"],alias_result["scores"],alias_result["text_labels"]):
            if not ("low" in text_label or "coffee" in text_label): continue
            candidate_box = [float(v) for v in box.cpu().tolist()]
            # A requested coffee table cannot borrow the dining-table box.
            if any(box_iou(candidate_box,other["bbox"]) > 0.35 for other in detections.get("dining table",[])): continue
            alternative.append({"bbox":candidate_box,"score":float(score.item()),"query":"coffee table (low table synonym)","matched_label":text_label})
        if alternative:
            detections["coffee table"] = sorted(alternative,key=lambda row:row["score"],reverse=True)[:1]
    del model, processor, outputs, inputs
    if device == "mps": torch.mps.empty_cache()
    assignments = []
    for query, group in queries.items():
        candidates = detections.get(query, [])
        # Same category + distinct catalogue SKUs cannot be identified reliably
        # by category alone. Do not pretend the first armchair is either SKU.
        if len(group) > 1:
            for product in group:
                diagnostics.append({"candidate_key": product["candidate_key"], "reason": "ambiguous_multiple_references_same_typology", "query": query})
            continue
        product = group[0]
        if not candidates:
            diagnostics.append({"candidate_key": product["candidate_key"], "reason": "no_confident_pixel_detection", "query": query})
            continue
        assignments.append({**candidates[0], "product": product})
    exclusions = [candidate for query in all_queries if query not in queries for candidate in detections.get(query, [])[:2]]
    sam_entries = assignments + exclusions
    if not sam_entries:
        return {"schema_version": "local-product-locator.result.v1", "image_sha256": image_sha, "hotspots": [], "diagnostics": diagnostics, "paid_api_calls": 0}
    sam_processor = SamProcessor.from_pretrained(ASSETS / "sam-vit-base", local_files_only=True)
    sam_model = SamModel.from_pretrained(ASSETS / "sam-vit-base", local_files_only=True).to(device).eval()
    sam_inputs = sam_processor(image, input_boxes=[[entry["bbox"] for entry in sam_entries]], return_tensors="pt")
    # Python coordinates / NumPy may create float64 tensors; Apple MPS supports
    # float32 only. Integer metadata must keep its integer type.
    sam_inputs = {key: (value.float() if value.is_floating_point() else value).to(device) for key,value in sam_inputs.items()}
    with torch.inference_mode():
        sam_outputs = sam_model(**sam_inputs, multimask_output=True)
    mask_scores = sam_outputs.iou_scores[0].cpu().numpy()
    best_indexes = torch.from_numpy(mask_scores.argmax(axis=1)).long()
    predicted_masks = sam_outputs.pred_masks.cpu()
    # Upscale only the best mask per object, rather than all three SAM outputs.
    # This keeps memory bounded when several catalogue references are selected.
    mask_height,mask_width = predicted_masks.shape[-2:]
    gather_indexes = best_indexes.reshape(1,-1,1,1,1).expand(1,-1,1,mask_height,mask_width)
    best_masks = predicted_masks.gather(2,gather_indexes)
    masks = sam_processor.image_processor.post_process_masks(best_masks, sam_inputs["original_sizes"].cpu(), sam_inputs["reshaped_input_sizes"].cpu())[0].numpy()
    all_masks = []
    for index, entry in enumerate(sam_entries):
        best = int(mask_scores[index].argmax())
        mask = masks[index, 0].astype(bool)
        # Restrict predicted mask to the detected object's box. SAM occasionally
        # extends a prompted object into a neighboring one.
        x0,y0,x1,y1 = [int(v) for v in entry["bbox"]]
        box_mask = np.zeros((height, width), dtype=bool)
        box_mask[max(0,y0):min(height,y1+1), max(0,x0):min(width,x1+1)] = True
        mask &= box_mask
        all_masks.append((mask, float(mask_scores[index,best])))
    hotspots = []
    debug_masks = []
    for index, entry in enumerate(assignments):
        product = entry["product"]
        mask, mask_score = all_masks[index]
        if mask_score < MASK_THRESHOLD:
            diagnostics.append({"candidate_key": product["candidate_key"], "reason": "uncertain_visible_mask", "mask_score": round(mask_score,4)})
            continue
        obstacles = None
        if product["role"] in SURFACES | {"rug"}:
            obstacles = np.zeros((height,width), dtype=bool)
            for other_index, other in enumerate(sam_entries):
                if other_index == index: continue
                other_role = other.get("product", {}).get("role")
                if product["role"] == "rug" and other_role in SURFACES: continue
                if product["role"] in SURFACES and other_role in SURFACES: continue
                other_mask, other_score = all_masks[other_index]
                if other_score >= MASK_THRESHOLD: obstacles |= other_mask
        point = interior_point(mask, obstacles)
        if point is None:
            diagnostics.append({"candidate_key": product["candidate_key"], "reason": "no_safe_visible_interior"})
            continue
        x,y,margin,visible_pixels = point
        hotspots.append({"candidate_key":product["candidate_key"], "catalog_id":product["catalog_id"], "variant_id":product.get("variant_id"),
                         "x":round((x+0.5)/width,7), "y":round((y+0.5)/height,7),
                         "confidence":round(entry["score"],4), "position_source":"automatic_local_detection", "human_verified":False,
                         "evidence":{"query":entry["query"], "bbox":[round(v/size,7) for v,size in zip(entry["bbox"],[width,height,width,height])],
                                     "mask_score":round(mask_score,4), "interior_margin_pixels":margin,"visible_mask_pixels":visible_pixels,
                                     "sku_fidelity_verified":False}})
        debug_masks.append((mask, (x,y), product["candidate_key"]))
    if debug_path:
        from PIL import ImageDraw
        debug = image.copy(); draw = ImageDraw.Draw(debug)
        for index, (mask,point,key) in enumerate(debug_masks):
            x,y = point; draw.ellipse((x-8,y-8,x+8,y+8),fill=(0,140,255),outline="white",width=2)
            draw.text((x+10,y-5),key,fill="blue",stroke_width=1,stroke_fill="white")
        debug.save(debug_path)
    return {"schema_version":"local-product-locator.result.v1","image_sha256":image_sha,"image":{"width":width,"height":height},
            "hotspots":hotspots,"diagnostics":diagnostics,"paid_api_calls":0,"image_uploads":0,
            "provenance":{"algorithm":ALGORITHM,"device":device,"models":[{"id":m["id"],"revision":m["revision"],"license":m["license"]} for m in manifest["models"]],
                          "detector_threshold":THRESHOLD,"mask_threshold":MASK_THRESHOLD,"sku_fidelity_verified":False,"human_verified":False,
                          "reference_images_used":False,"association_method":"sole_selected_reference_per_detected_typology"},
            "elapsed_seconds":round(time.monotonic()-start,3)}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", nargs="?", default="-")
    parser.add_argument("output", nargs="?", default="-")
    parser.add_argument("--device", choices=["auto","cpu","mps"], default="auto")
    parser.add_argument("--debug-image")
    args = parser.parse_args()
    payload = json.load(sys.stdin) if args.input == "-" else json.loads(Path(args.input).read_text())
    result = locate(payload,args.device,args.debug_image)
    serialized = json.dumps(result, ensure_ascii=False) + "\n"
    if args.output == "-": sys.stdout.write(serialized)
    else: Path(args.output).write_text(serialized)

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Model/runtime diagnostics only. Never stringify inherited environment.
        print(json.dumps({"ok":False,"error":type(error).__name__,"message":str(error)[:400],"paid_api_calls":0}),file=sys.stderr)
        sys.exit(1)
