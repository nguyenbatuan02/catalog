"""
vin.py — Tra model_code từ VIN qua PartSouq, dùng undetected_chromedriver
(né được chặn Cloudflare vì giả lập trình duyệt thật).

Dùng độc lập (gõ tay):
    python vin.py

Dùng từ backend (Node spawn subprocess) — truyền VIN qua argv, in ra
ĐÚNG 1 DÒNG JSON cuối cùng để dễ parse, không hỏi input():
    python vin.py JTDBT923291234569
    → {"ok": true, "brand": "TOYOTA", "year": "2007", "name": "YARIS", "model_code": "NCP93L-BEPRKA"}
    hoặc lỗi: {"ok": false, "error": "..."}
"""
import sys
import json
import undetected_chromedriver as uc
from selenium.webdriver.support.ui import WebDriverWait

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def get_model_code(vin: str, log=True) -> dict:
    url = f"https://partsouq.com/en/search/all?q={vin}"
    options = uc.ChromeOptions()
    driver = uc.Chrome(options=options, headless=False, version_main=152)

    try:
        driver.get(url)
        if log:
            print("⏳ Đang chờ redirect...", file=sys.stderr)

        # Chờ tới trang xe. PartSouq redirect 2 bước:
        #   /search/all -> /catalog/{brand}/search?vin=... -> /catalog/{brand}/vehicle/...
        # nên phải chờ "/vehicle/", chờ "/catalog/" sẽ dừng ở bước giữa.
        WebDriverWait(driver, 60).until(lambda d: "/vehicle/" in d.current_url)

        current_url = driver.current_url
        if log:
            print(f"URL: {current_url}", file=sys.stderr)

        # dạng: .../catalog/{brand}/vehicle/{NA}/{year}/{name}/{model_code}/...
        parts = current_url.split("?")[0].split("/")
        i = parts.index("vehicle")
        if len(parts) < i + 5:
            return {"ok": False, "error": f"URL không đúng dạng mong đợi: {current_url}"}

        brand = parts[i - 1]
        year = parts[i + 2]
        name = parts[i + 3]
        model_code = parts[i + 4]

        return {
            "ok": True,
            "vin": vin,
            "brand": brand.upper(),
            "year": year,
            "name": name,
            "model_code": model_code,
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        driver.quit()


if __name__ == "__main__":
    if len(sys.argv) > 1:
        # Gọi từ backend — không hỏi input(), chỉ in JSON kết quả ra stdout.
        vin_arg = sys.argv[1].strip().upper()
        result = get_model_code(vin_arg, log=True)
        print(json.dumps(result, ensure_ascii=False))
    else:
        # Gõ tay để test độc lập
        vin_arg = input("Nhập VIN: ").strip().upper()
        result = get_model_code(vin_arg, log=True)
        print(f"Brand     : {result.get('brand','?')}")
        print(f"Year      : {result.get('year','?')}")
        print(f"Name      : {result.get('name','?')}")
        print(f"Model code: {result.get('model_code','?')}")
        if not result.get("ok"):
            print(f"Lỗi: {result.get('error')}")
