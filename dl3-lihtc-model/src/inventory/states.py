STATE_NAMES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California", "CO": "Colorado",
    "CT": "Connecticut", "DE": "Delaware", "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho",
    "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana",
    "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York", "NC": "North Carolina",
    "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania",
    "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas",
    "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia",
    "WI": "Wisconsin", "WY": "Wyoming", "DC": "District of Columbia", "PR": "Puerto Rico",
    "VI": "Virgin Islands", "GU": "Guam", "AS": "American Samoa", "MP": "Northern Mariana Islands",
}
NAME_TO_CODE = {v.lower(): k for k, v in STATE_NAMES.items()}
NAME_TO_CODE.update({"washington, d.c.": "DC", "washington dc": "DC", "u.s. virgin islands": "VI",
                     "us virgin islands": "VI"})


def match_state(text: str) -> str | None:
    """State code if `text` is a state heading/cell (full name or exact 2-letter code)."""
    t = " ".join(text.split()).strip(" :").lower()
    if not t or len(t) > 40:
        return None
    if t.upper() in STATE_NAMES and len(t) == 2:
        return t.upper()
    if t in NAME_TO_CODE:
        return NAME_TO_CODE[t]
    # "Michigan (MSHDA)" or "New York - State" style headings; not "Kansas City Housing"
    for name in sorted(NAME_TO_CODE, key=len, reverse=True):
        rest = t[len(name):].lstrip()
        if t.startswith(name) and rest[:1] in ("(", "-", "–", ":", ","):
            return NAME_TO_CODE[name]
    return None
