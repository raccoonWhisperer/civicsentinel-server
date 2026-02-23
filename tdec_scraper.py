#!/usr/bin/env python3
import json, os, time, argparse, logging
from datetime import datetime
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import Select
from webdriver_manager.chrome import ChromeDriverManager
from bs4 import BeautifulSoup
DATA_DIR = Path("./data")
DATA_DIR.mkdir(exist_ok=True)
COUNTIES = ["Rutherford","Wilson","Williamson","Davidson","Bedford","Cannon"]
KEYWORDS = ["geothermal","karst","sinkhole","subsidence","cave","void","well explosion","well damage","groundwater","aquifer","foundation","ground collapse","drilling damage","water well","baker road","baker rd","poplar hill","blackman","mid-state","rg anderson"]
PAGES = {"complaints": "https://dataviewers.tdec.tn.gov/dataviewers/f?p=9034:34250::::::", "permits": "https://dataviewers.tdec.tn.gov/dataviewers/f?p=9034:34001", "inspections": "https://dataviewers.tdec.tn.gov/dataviewers/f?p=9034:34200::::::", "water_wells": "https://dataviewers.tdec.tn.gov/dataviewers/f?p=2005:39900::::::", "drillers": "https://dataviewers.tdec.tn.gov/dataviewers/f?p=2005:39906::::::"}
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s', handlers=[logging.StreamHandler(), logging.FileHandler(DATA_DIR / "scraper.log")])
logger = logging.getLogger("tdec")
def create_browser():
    opts = Options()
    opts.add_argument("--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_argument("--window-size=1400,900")
    opts.add_experimental_option("excludeSwitches", ["enable-automation"])
    opts.add_experimental_option("useAutomationExtension", False)
    driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=opts)
    driver.execute_cdp_cmd("Network.setUserAgentOverride", {"userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"})
    driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"})
    return driver
def extract_table(driver):
    soup = BeautifulSoup(driver.page_source, "html.parser")
    headers, rows = [], []
    for table in soup.find_all("table"):
        for row in table.find_all("tr"):
            ths = row.find_all("th")
            tds = row.find_all("td")
            if ths and not headers:
                headers = [th.get_text(strip=True) for th in ths]
            elif tds and headers:
                vals = [td.get_text(strip=True) for td in tds]
                if len(vals) >= 3:
                    rows.append({headers[i]: vals[i] for i in range(min(len(headers), len(vals)))})
    return headers, rows
def try_show_all(driver):
    try:
        for se in driver.find_elements(By.TAG_NAME, "select"):
            try:
                s = Select(se)
                for t in ["1000","500","100","All"]:
                    if t in [o.text.strip() for o in s.options]:
                        s.select_by_visible_text(t)
                        logger.info(f"  Rows set to {t}")
                        time.sleep(5)
                        return
            except Exception: continue
    except Exception: pass
def remove_filters(driver):
    ct = 0
    for _ in range(5):
        try:
            b = driver.find_elements(By.CSS_SELECTOR, "a[title='Remove Filter']")
            if not b: b = driver.find_elements(By.XPATH, "//a[contains(@title,'Remove')]")
            if b: b[0].click(); ct += 1; time.sleep(3)
            else: break
        except Exception: break
    if ct: logger.info(f"  Removed {ct} filters")
def paginate(driver):
    allr, seen = [], set()
    for pg in range(50):
        _, rows = extract_table(driver)
        nr = [r for r in rows if json.dumps(r, sort_keys=True) not in seen]
        for r in nr: seen.add(json.dumps(r, sort_keys=True))
        if not nr and pg > 0: break
        allr.extend(nr)
        logger.info(f"  Pg {pg+1}: +{len(nr)} (tot: {len(allr)})")
        try:
            nx = driver.find_elements(By.CSS_SELECTOR, "a.a-IRR-pagination-next")
            if not nx: nx = driver.find_elements(By.XPATH, "//a[text()='>']")
            if not nx: nx = driver.find_elements(By.XPATH, "//a[contains(@title,'Next')]")
            if nx: nx[0].click(); time.sleep(4)
            else: break
        except Exception: break
    return allr
def filt(recs):
    out = []
    for r in recs:
        t = json.dumps(r).lower()
        cm = any(c.lower() in t for c in COUNTIES)
        km = any(k in t for k in KEYWORDS)
        if cm or km: r["_priority"] = "HIGH" if km else "NORMAL"; out.append(r)
    return out
def save(fn, recs, tot=0):
    with open(DATA_DIR/fn,"w") as f: json.dump({"records":recs,"last_updated":datetime.now().isoformat(),"total_count":len(recs),"all_state_records":tot},f,indent=2,default=str)
    logger.info(f"  Saved {len(recs)} to {fn} ({tot} statewide)")
def scrape(driver, name, url, fn, idf="ID", rmf=True):
    logger.info(f"=== TDEC {name} ===")
    driver.get(url); time.sleep(10)
    if rmf: remove_filters(driver); time.sleep(3)
    try_show_all(driver); time.sleep(3)
    ar = paginate(driver)
    logger.info(f"  Total: {len(ar)}")
    fl = filt(ar)
    logger.info(f"  Local: {len(fl)}")
    for r in fl: r["source"]=f"TDEC {name}"; r["scraped_at"]=datetime.now().isoformat()
    save(f"all_{fn}", ar, len(ar)); save(fn, fl, len(ar))
    for r in fl[:20]: logger.info(f"    [{r.get('_priority','')}] {r.get(idf,'')}-{r.get('County','')}-{r.get('Concerning',r.get('Site',''))}")
    return fl
def search_data(kw):
    logger.info(f"=== Search: {kw} ===")
    res = []
    for fn in DATA_DIR.glob("all_*.json"):
        with open(fn) as f: d = json.load(f)
        for r in d.get("records",[]):
            if kw.lower() in json.dumps(r).lower(): res.append({"file":fn.name,"record":r})
    logger.info(f"  {len(res)} matches")
    for r in res: logger.info(f"    {json.dumps(r['record'])}")
    with open(DATA_DIR/f"search_{kw.replace(' ','_')}.json","w") as f: json.dump(res,f,indent=2,default=str)
def main():
    p = argparse.ArgumentParser()
    p.add_argument("--mode", choices=["all","complaints","permits","inspections","wells","drillers","search"], default="all")
    p.add_argument("--search", type=str)
    a = p.parse_args()
    if a.mode == "search": search_data(a.search or "baker road"); return
    logger.info("CivicSentinel TDEC Scraper v3")
    driver = create_browser()
    try:
        if a.mode in ["all","complaints"]: scrape(driver,"DWR Complaints",PAGES["complaints"],"tdec_complaints.json",rmf=True); time.sleep(2)
        if a.mode in ["all","permits"]: scrape(driver,"DWR Permits",PAGES["permits"],"tdec_permits.json",idf="Permit No",rmf=False); time.sleep(2)
        if a.mode in ["all","inspections"]: scrape(driver,"DWR Inspections",PAGES["inspections"],"tdec_inspections.json",rmf=True); time.sleep(2)
        if a.mode in ["all","wells"]: scrape(driver,"Water Wells",PAGES["water_wells"],"tdec_wells.json",rmf=False); time.sleep(2)
        if a.mode in ["all","drillers"]: scrape(driver,"Licensed Drillers",PAGES["drillers"],"tdec_drillers.json",idf="License No",rmf=False)
    except Exception as e: logger.error(f"Error: {e}"); import traceback; traceback.print_exc()
    finally: driver.quit(); logger.info("Done.")
if __name__ == "__main__": main()
