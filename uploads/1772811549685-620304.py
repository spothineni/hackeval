"""
generate_fixtures.py — Creates synthetic CMS Form 2567 test PDFs using ReportLab.

Run once to (re)generate fixture PDFs:
    python tests/fixtures/generate_fixtures.py

Produces:
    tests/fixtures/two_citations.pdf   — Two F-tags, G+F severity, residents
    tests/fixtures/minimal.pdf         — Single F-tag, no residents, no date
    tests/fixtures/multi_page.pdf      — F-tags spread across 3 pages
"""

import sys
from pathlib import Path

# Allow running from the repo root or from within tests/fixtures/
FIXTURES_DIR = Path(__file__).parent
sys.path.insert(0, str(FIXTURES_DIR.parent.parent))

from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, PageBreak
from reportlab.lib.styles import getSampleStyleSheet
import io


def _make_pdf(content_blocks: list[str], filename: str) -> None:
    """Write a simple text PDF to FIXTURES_DIR/<filename>."""
    styles = getSampleStyleSheet()
    body = styles["Normal"]
    body.fontSize = 10
    body.leading = 14

    path = FIXTURES_DIR / filename
    doc = SimpleDocTemplate(str(path), pagesize=letter,
                            leftMargin=inch, rightMargin=inch,
                            topMargin=inch, bottomMargin=inch)

    story = []
    for block in content_blocks:
        if block == "<<<PAGE_BREAK>>>":
            story.append(PageBreak())
        else:
            for line in block.splitlines():
                line = line.strip()
                safe = line.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                story.append(Paragraph(safe or "&nbsp;", body))
    doc.build(story)
    print(f"  Created: {path}")


def main():
    print("Generating test PDF fixtures…")

    # ── 1. Two citations ──────────────────────────────────────────────────────
    _make_pdf([
        """DEPARTMENT OF HEALTH AND HUMAN SERVICES
CENTERS FOR MEDICARE & MEDICAID SERVICES

STATEMENT OF DEFICIENCIES AND PLAN OF CORRECTION

Facility Name: Sunrise Gardens Skilled Nursing Facility
Survey Date: 03/15/2024
CCN: 123456

F 0561 Self-Determination Resident Choice
Severity: G

Based on observation, interview, and record review, the facility failed to honor
the bathing preferences of 2 residents (Resident #27 and Resident #31) out of
5 sampled residents.

Findings include:

Resident #27's care plan documented a preference for baths. During observation
on 03/12/2024 at 09:30 AM, the resident was observed receiving a shower.
Resident #31 reported to the surveyor that staff do not follow their stated
preference for morning care routines.

F0880 Infection Prevention and Control
Severity: F

Based on observation and interview, the facility failed to ensure staff
performed hand hygiene between resident contacts in 3 of 5 observed instances.

Resident #8 and Resident #14 on Unit 2 were at risk for cross-contamination.
Staff member observed moving from Resident #8 to Resident #14 without performing
hand hygiene or changing gloves.
"""
    ], "two_citations.pdf")

    # ── 2. Minimal — single F-tag, no residents, no date ─────────────────────
    _make_pdf([
        """STATEMENT OF DEFICIENCIES

Facility Name: Lakewood Care Center

F0700 Dignity and Respect
Severity: D

The facility failed to ensure that staff treated residents with dignity during
personal care activities on one occasion observed during the survey period.
Staff was observed using dismissive language while assisting a resident.
"""
    ], "minimal.pdf")

    # ── 3. Multi-page — F-tags split across three pages ───────────────────────
    _make_pdf([
        """STATEMENT OF DEFICIENCIES AND PLAN OF CORRECTION

Facility Name: Blue Ridge Health and Rehabilitation Center
Survey Date: 07/22/2024

F 0550 Respect Dignity Rights Grievances
Severity: E

The facility failed to ensure the grievance policy was followed for 2 of 4
residents (Resident #5 and Resident #9) who filed formal grievances.

Grievance records for Resident #5 lacked required written responses.
Resident #9 reported to the surveyor that their grievance was never addressed.
""",
        "<<<PAGE_BREAK>>>",
        """F0600 Free from Abuse and Neglect
Severity: J

The facility failed to protect residents from abuse. One incident involving
Resident #12 was not reported to the State agency within the required timeframe.

Interview with Resident #12 on 07/20/2024 confirmed the allegation was
substantiated but not escalated per policy.
""",
        "<<<PAGE_BREAK>>>",
        """F0812 Food Procurement Preparation and Service
Severity: F

The facility failed to ensure food was prepared and served under sanitary
conditions. During kitchen observation on 07/19/2024:

- Raw chicken was stored above ready-to-eat foods (Resident #22 affected).
- Refrigerator temperature log was not completed for 3 consecutive days.
- Staff observed not wearing gloves while portioning food.
"""
    ], "multi_page.pdf")

    print("Done. 3 fixture PDFs created in tests/fixtures/")


if __name__ == "__main__":
    main()
