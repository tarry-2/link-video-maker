#!/usr/bin/env python3
# Wan2.2 T2V — 정본 번들(Wan2.2_T2V.json) 배선 그대로 API 포맷으로 재구성해 /prompt 제출.
# 공식소스 근거: hearmeman 번들 워크플로 + ComfyUI object_info 스키마.
import sys, json, time, random, urllib.request, urllib.error

POD = sys.argv[1] if len(sys.argv) > 1 else "0tbrmff9b1fiod"
PROMPT = sys.argv[2] if len(sys.argv) > 2 else (
    "A chef rabbit wearing a white chef hat tossing colorful vegetables in a sizzling pan, "
    "cozy rustic kitchen, warm golden light, steam and sparks rising, shallow depth of field, "
    "photorealistic, cinematic, highly detailed, smooth camera push-in")
OUTNAME = sys.argv[3] if len(sys.argv) > 3 else "wan_test"
BASE = f"https://{POD}-8188.proxy.runpod.net"
UA = {"User-Agent": "Mozilla/5.0", "Content-Type": "application/json"}
HI = "wan2.2_t2v_high_noise_14B_fp16.safetensors"
LO = "wan2.2_t2v_low_noise_14B_fp16.safetensors"
HLORA = "wan2.2_t2v_A14b_high_noise_lora_rank64_lightx2v_4step_1217.safetensors"
LLORA = "wan2.2_t2v_A14b_low_noise_lora_rank64_lightx2v_4step_1217.safetensors"
seed = random.randint(0, 2**50)

g = {
  "1": {"class_type": "UNETLoader", "inputs": {"unet_name": HI, "weight_dtype": "default"}},
  "2": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": HLORA, "strength_model": 1.0}},
  "3": {"class_type": "ModelSamplingSD3", "inputs": {"model": ["2", 0], "shift": 5.0}},
  "4": {"class_type": "PathchSageAttentionKJ", "inputs": {"model": ["3", 0], "sage_attention": "auto"}},
  "5": {"class_type": "UNETLoader", "inputs": {"unet_name": LO, "weight_dtype": "default"}},
  "6": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["5", 0], "lora_name": LLORA, "strength_model": 1.0}},
  "7": {"class_type": "ModelSamplingSD3", "inputs": {"model": ["6", 0], "shift": 5.0}},
  "8": {"class_type": "PathchSageAttentionKJ", "inputs": {"model": ["7", 0], "sage_attention": "auto"}},
  "9": {"class_type": "CLIPLoader", "inputs": {"clip_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "type": "wan", "device": "default"}},
  "10": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["9", 0], "text": PROMPT}},
  "11": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["10", 0]}},
  "12": {"class_type": "EmptyHunyuanLatentVideo", "inputs": {"width": 480, "height": 832, "length": 81, "batch_size": 1}},
  "13": {"class_type": "KSamplerAdvanced", "inputs": {"add_noise": "enable", "noise_seed": seed, "steps": 8, "cfg": 1.0,
         "sampler_name": "euler", "scheduler": "simple", "start_at_step": 0, "end_at_step": 4, "return_with_leftover_noise": "enable",
         "model": ["4", 0], "positive": ["10", 0], "negative": ["11", 0], "latent_image": ["12", 0]}},
  "14": {"class_type": "KSamplerAdvanced", "inputs": {"add_noise": "disable", "noise_seed": seed, "steps": 8, "cfg": 1.0,
         "sampler_name": "euler", "scheduler": "simple", "start_at_step": 4, "end_at_step": 10000, "return_with_leftover_noise": "disable",
         "model": ["8", 0], "positive": ["10", 0], "negative": ["11", 0], "latent_image": ["13", 0]}},
  "15": {"class_type": "VAELoader", "inputs": {"vae_name": "wan_2.1_vae.safetensors"}},
  "16": {"class_type": "VAEDecode", "inputs": {"samples": ["14", 0], "vae": ["15", 0]}},
  "17": {"class_type": "FrameInterpolationModelLoader", "inputs": {"model_name": "rife426.pth"}},
  "18": {"class_type": "FrameInterpolate", "inputs": {"interp_model": ["17", 0], "images": ["16", 0], "multiplier": 4}},
  "19": {"class_type": "VHS_VideoCombine", "inputs": {"images": ["18", 0], "frame_rate": 60, "loop_count": 0,
         "filename_prefix": OUTNAME, "format": "video/h264-mp4", "pingpong": False, "save_output": True}},
}

def post(path, data):
    r = urllib.request.Request(BASE + path, data=json.dumps(data).encode(), headers=UA, method="POST")
    return json.loads(urllib.request.urlopen(r, timeout=60).read())

def get(path):
    r = urllib.request.Request(BASE + path, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(r, timeout=60).read()

client_id = f"onvideo-{random.randint(1000,9999)}"
print(f"[제출] seed={seed} prompt='{PROMPT[:50]}...'")
try:
    res = post("/prompt", {"prompt": g, "client_id": client_id})
except urllib.error.HTTPError as e:
    print("[제출실패]", e.code, e.read().decode()[:800]); sys.exit(1)
pid = res["prompt_id"]
print(f"[큐] prompt_id={pid}")

t0 = time.time()
while True:
    time.sleep(6)
    try:
        h = json.loads(get(f"/history/{pid}"))
    except Exception as ex:
        print("  poll err", ex); continue
    if pid in h:
        st = h[pid].get("status", {})
        if st.get("completed") or st.get("status_str") == "success":
            outs = h[pid]["outputs"]
            print(f"[완료] {time.time()-t0:.0f}s outputs nodes: {list(outs.keys())}")
            saved = []
            for nid, o in outs.items():
                for key in ("gifs", "videos", "images"):
                    for f in o.get(key, []):
                        q = f"/view?filename={urllib.parse.quote(f['filename'])}&subfolder={urllib.parse.quote(f.get('subfolder',''))}&type={f.get('type','output')}"
                        data = get(q)
                        dest = f"/Users/apple/Desktop/{OUTNAME}_{nid}_{f['filename']}"
                        open(dest, "wb").write(data)
                        saved.append((dest, len(data)))
                        print(f"  저장 {dest} ({len(data)//1024}KB)")
            print("[끝]", saved); break
        if st.get("status_str") == "error":
            print("[에러]", json.dumps(h[pid].get("status"), ensure_ascii=False)[:1500]); break
    if time.time() - t0 > 900:
        print("[타임아웃] 15분"); break
