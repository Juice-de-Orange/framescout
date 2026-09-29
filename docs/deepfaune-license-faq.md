# DeepFaune license — plain-English FAQ

> **This is not legal advice.** It is a developer's reading of how
> the DeepFaune V1.3 model weights' license interacts with common
> Framescout deployment patterns. The authoritative document is
> the [CC BY-NC-SA 4.0 deed](https://creativecommons.org/licenses/by-nc-sa/4.0/)
> and the upstream
> [DeepFaune project page](https://www.deepfaune.cnrs.fr/). Consult a
> lawyer before relying on anything here for a contract or a
> compliance review.

## What is licensed and how?

| Artefact                                      | License           | Owner / source |
|-----------------------------------------------|-------------------|----------------|
| `@framescout/detector-deepfaune-http` (TS code) | **Apache-2.0**    | This repo (Framescout authors). |
| DeepFaune V1.3 **model weights**              | **CC BY-NC-SA 4.0** | DeepFaune project (CNRS). |
| Any HTTP wrapper *you* run around DeepFaune   | Whatever license you publish your wrapper under, **plus** the obligations of the weights it ships with. |
| Observations / images Framescout produces     | Yours (or your data-subject's, where applicable). |

The plugin **does not bundle** the weights. It POSTs frames to an
endpoint you control. The license obligations live with the
person who **operates the service that runs the weights**.

## What does "non-commercial" cover, in practice?

The CC BY-NC-SA 4.0 deed defines NonCommercial as "not primarily
intended for or directed towards commercial advantage or monetary
compensation." The license itself doesn't enumerate use cases; the
following table is one reading of how the spirit of the deed maps to
common Framescout deployments.

| Use case                                                       | Probably OK? | Why |
|----------------------------------------------------------------|--------------|-----|
| Hobbyist running Framescout in their own back garden, sending sightings to their personal Home Assistant | ✓ | No monetary compensation, no commercial advantage. |
| Conservation biologist using Framescout for a published academic study | ✓ | Research use is a paradigmatic NC use; the share-alike applies to outputs derived from the weights. |
| Citizen scientist contributing observations to iNaturalist / GBIF | ✓ | Open scientific data publication is not a commercial use of the model itself. |
| Wildlife photographer using Framescout to filter trail-cam SD cards for "good shots" they then post on a free Flickr account | ✓ (probably) | Free dissemination of derived works is not commercial use, but the share-alike still applies. |
| Wildlife photographer using Framescout to filter trail-cam SD cards for shots they sell on a stock-photo site | ✗ | The model output is being used "primarily for monetary compensation". This is a NotOK use case. |
| Paid consulting firm using Framescout to deliver an ecological-impact survey to a client | ✗ | The model output is the firm's deliverable; the firm is being paid. NC violation. |
| Private game-management estate using Framescout to monitor stocking levels of game animals they sell hunts on | ✗ | The model output informs commercial game-stocking decisions. |
| Government agency using Framescout for endangered-species monitoring, results published as open data | ✓ | Public-sector non-commercial; results released openly. |
| Same agency uses results to charge ecotourism licenses | ✗ | The agency is charging for access tied to the model output. |
| Educational institution running Framescout in a teaching lab | ✓ | Educational use is NC. |
| Same institution sells access to the teaching lab as a workshop | … | Depends on whether the model output is the product. If students just learn from running it, OK. If the institution markets the workshop as "use this DeepFaune setup to do X", that's closer to commercial use of the weights. |

The deed has a short, useful test: *would a reasonable person look at
your use and call it primarily commercial?* If yes, you're not in NC.
If no, you probably are.

## What if I'm doing something the table doesn't cover?

Three reasonable options:

1. **Replace the weights.** The `@framescout/detector-deepfaune-http`
   plugin doesn't ship weights; it just talks to whatever HTTP
   service you point it at. Run a commercially-licensed species
   classifier behind the same endpoint and you're out of the CC
   BY-NC-SA scope entirely. The plugin code is Apache-2.0 — you can
   re-use it under that license.
2. **Use a different detector.** Framescout's HTTP detectors are
   plugins. Swap in another plugin (commercial-license model,
   commercial-tier API, your own model) without changing the rest of
   the pipeline.
3. **Talk to a lawyer.** Especially for grey-zone cases (institutional
   use, paid services with non-commercial scientific components,
   etc.), the cost of a one-hour consult is small compared to the
   cost of distributing model-derived outputs you're not entitled to
   redistribute.

## What about the share-alike?

CC BY-NC-SA's "Share Alike" clause says that if you publish a
*Derivative Work* of the weights, you must publish it under the same
license. Two practical questions:

- **Are observation outputs derivatives?** The species labels, the
  bounding boxes, the scientific names — these are not the weights.
  They're outputs derived by running an algorithm on your input data
  with the help of the weights. Most readings of the deed treat these
  as derived works of *your input data*, not of the weights. The
  authoritative case law on ML-output derivativeness is unsettled,
  globally and in the EU.
- **Is a fine-tuned model a derivative?** Yes, unambiguously. If you
  fine-tune the DeepFaune weights on your local fauna and publish the
  result, the published fine-tuned weights are derivative and you must
  release them under CC BY-NC-SA 4.0.

## Attribution

CC BY-NC-SA requires attribution. When you publish observations
labelled with DeepFaune species names, credit upstream — for example:

> Species classification by [DeepFaune V1.3](https://www.deepfaune.cnrs.fr/),
> a model maintained by CNRS, used under
> [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).

The framework's observation envelope includes a `classifierModel.name`
+ `classifierModel.version` field exactly so this credit is
mechanically traceable.

## Final disclaimer

The Framescout project is **not affiliated with DeepFaune or CNRS**.
Errors in this FAQ are ours; corrections welcome via GitHub issue.
For canonical license interpretation, reach out to the DeepFaune
project directly.
