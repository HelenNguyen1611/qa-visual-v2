/**
 * Turn a raw finding write-up into Design / Live so a reviewer can scan it.
 * Understands the current format and the older measured / AI sentences still in report.json.
 */

export type FindingCompare = { design?: string; live?: string; extra?: string };

const cap = (s: string) => {
  const t = s.trim().replace(/\.+$/, '');
  if (!t) return t;
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export function findingCompare(detail: string): FindingCompare {
  const d = (detail ?? '').trim();
  if (!d) return {};

  const designLine = d.match(/^Design:\s*(.+)$/im);
  const liveLine = d.match(/^Live:\s*(.+)$/im);
  if (designLine && liveLine) {
    const extra = d
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => line && !/^(Design|Live):/i.test(line))
      .join(' ');
    return { design: cap(designLine[1]), live: cap(liveLine[1]), extra: extra || undefined };
  }

  const ai = d.match(/^In the design,\s*([\s\S]+?)\.\s*On the live site,\s*([\s\S]+)$/i);
  if (ai) return { design: cap(ai[1]), live: cap(ai[2]) };

  const ban = d.match(
    /Overlay text [“"'](.+?)[”"'] is (\d+)px from the image edge on the page,\s*Figma (\d+)px(?: \(×[\d.]+ → (\d+)px\))?/i,
  );
  if (ban) {
    const expected = ban[4] ?? ban[3];
    return {
      live: `“${ban[1]}” is ${ban[2]}px from the image edge`,
      design: `${expected}px from the image edge`,
    };
  }

  const asp = d.match(/Image (\d+)×(\d+)px \(aspect [\d.]+\) is off the rest of the row \(median [\d.]+, (\d+) images\)/i);
  if (asp) {
    return {
      live: `This card is ${asp[1]}×${asp[2]}px`,
      design: `The other images in the row are a different shape (${asp[3]} compared)`,
    };
  }

  const ov = d.match(/Two text blocks overlap by (\d+)%[^(]*:\s*[“"](.+?)[”"] and [“"](.+?)[”"]/i);
  if (ov) {
    return {
      live: `“${ov[2]}” and “${ov[3]}” overlap by ${ov[1]}%`,
      design: 'Text should not cover other text',
    };
  }

  const em = d.match(/No text or media in y = [\d.]+ … [\d.]+ \((\d+)px, (\d+)% of the (\d+)px first screen\)/i);
  if (em) {
    return {
      live: `${em[1]}px empty gap (${em[2]}% of the first screen)`,
      design: 'The first screen should be filled with content',
    };
  }

  const ty = d.match(
    /Largest (H[123]) on the page is (\d+)px \([“"](.+?)[”"]\), while the largest (H[123]) is (\d+)px \([“"](.+?)[”"]\)/i,
  );
  if (ty) {
    return {
      live: `${ty[1]} “${ty[3]}” is ${ty[2]}px; ${ty[4]} “${ty[6]}” is ${ty[5]}px`,
      design: `${ty[1]} should be the same size as ${ty[4]}, or larger`,
    };
  }

  return { extra: d };
}

const VP: Record<string, string> = { mobile: 'Mobile', tablet: 'Tablet', desktop: 'Desktop' };

/** Old report.json titles were written for engineers. Map the known ones. */
export function findingTitle(title: string, detail: string, anchors?: string[]): string {
  if (/banner inset differs from figma/i.test(title)) {
    const q = detail.match(/[“"]([^”"]{1,80})[”"]/)?.[1] || anchors?.[0];
    return q ? `“${q}” is too far from the banner edge` : 'Text is too far from the banner edge';
  }
  if (/card image aspect differs/i.test(title)) return 'Card image is a different shape than the rest of the row';
  if (/^overlapping text$/i.test(title)) return 'Text covers other text';
  if (/large empty band/i.test(title)) return 'Empty gap on the first screen';
  return title;
}

/**
 * What a finding rests on — the thing a reader needs before deciding how much to trust it.
 *
 * Three bases, not two, because "measured" covers two very different situations. A text box that
 * intersects another text box is a fact of this page: nothing outside the screenshot can make it
 * wrong. A 27px gap that Figma calls 53px is only as good as the pairing that decided those two
 * strings are the same two strings — and pairing is the part that gets it wrong. Showing both
 * under one "measured" badge is what makes a wrong one discredit a right one.
 */
export type FindingBasis = 'page' | 'design' | 'ai';

export const BASIS: Record<FindingBasis, { short: string; label: string; caveat?: string }> = {
  page: {
    short: 'page',
    label: 'Measured on the page',
    caveat: 'Taken from the page’s own numbers — no design reference involved.',
  },
  design: {
    short: 'design',
    label: 'Compared with the design',
    caveat: 'Depends on this text being matched to the right element in the Figma frame. Check the pairing before treating it as a bug.',
  },
  ai: {
    short: 'AI',
    label: 'Reported by the AI',
    caveat: 'Described by the model from the screenshots, not measured.',
  },
};

export function findingBasis(f: { measured?: boolean; locatedHow?: string }): FindingBasis {
  if (!f.measured) return 'ai';
  const how = f.locatedHow ?? '';
  // No `locatedHow` means the crop was never resolved, so the basis is unknown. Unknown goes to
  // the tier that asks for a second look, never to the one that claims proof.
  if (!how) return 'design';
  return /figma|design/i.test(how) ? 'design' : 'page';
}

export function findingStatus(f: {
  severity: string;
  viewports: string[];
  scope?: string;
  isNew?: boolean;
}): string {
  const bits = [
    f.severity === 'major' ? 'Major' : f.severity === 'note' ? 'Note' : 'Minor',
    f.viewports.map((v) => VP[v] ?? v).join(', '),
    f.scope === 'template' ? 'on every page' : null,
    f.isNew === true ? 'new this run' : f.isNew === false ? 'also in last run' : null,
  ];
  return bits.filter(Boolean).join(' · ');
}
