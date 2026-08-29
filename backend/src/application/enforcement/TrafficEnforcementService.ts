import type { DeviceRepository } from "../../domain/repositories/DeviceRepository.js";
import type { DevicePolicyRepository } from "../../domain/repositories/DevicePolicyRepository.js";

import { MacAddress } from "../../domain/value-objects/MacAddress.js";

import type {
  TrafficEnforcer,
} from "./TrafficEnforcer.js";

import type {
  TrafficPolicyInput,
  TrafficPolicyValidator,
} from "./TrafficPolicyValidator.js";
import type { OperationsRepository } from "../../domain/repositories/OperationsRepository.js";
import { resolveDeviceIdentifier } from "../devices/DeviceIdentifierResolver.js";

export class TrafficEnforcementService {
  constructor(
    private readonly trafficEnforcer:
      TrafficEnforcer,

    private readonly trafficPolicyValidator:
      TrafficPolicyValidator,

    private readonly deviceRepository:
      DeviceRepository,

    private readonly policyRepository:
      DevicePolicyRepository,

    private readonly quotaThrottleMbps = 0.5,

    private readonly operationsRepository?: OperationsRepository,
  ) {}

  /*
   * ============================================================
   * MANUAL DOWNLOAD LIMIT
   * ============================================================
   */

  async limitDownload(
    mac: string,
    input: TrafficPolicyInput,
  ): Promise<void> {
    const device =
      await resolveDeviceIdentifier(this.deviceRepository, mac);

    if (!device) {
      throw new Error(
        `Device not found: ${mac}`,
      );
    }

    if (!device.identityValidated) {
      throw new Error(`Device identity is not validated: ${mac}`);
    }

    this.trafficPolicyValidator.validate(
      device,
      input,
    );

    try {
      await this.trafficEnforcer.limitDownload(device, input);
      await this.policyRepository.upsert(device.id, {downloadLimit: input.rateMbps});
      await this.operationsRepository?.audit({action:"set-download-limit",mac:device.mac.toString(),deviceId:device.id,details:{rateMilliMbps:input.rateMbps.toString(),result:"success"}});
    } catch (error) {
      await this.operationsRepository?.audit({action:"set-download-limit",mac:device.mac.toString(),deviceId:device.id,details:{result:"failure",error:error instanceof Error?error.message:String(error)}});
      throw error;
    }
  }

  /*
   * ============================================================
   * MANUAL UPLOAD LIMIT
   * ============================================================
   */

  async limitUpload(
    mac: string,
    input: TrafficPolicyInput,
  ): Promise<void> {
    const device =
      await resolveDeviceIdentifier(this.deviceRepository, mac);

    if (!device) {
      throw new Error(
        `Device not found: ${mac}`,
      );
    }

    if (!device.identityValidated) {
      throw new Error(`Device identity is not validated: ${mac}`);
    }

    this.trafficPolicyValidator.validate(
      device,
      input,
    );

    try {
      await this.trafficEnforcer.limitUpload(device, input);
      await this.policyRepository.upsert(device.id, {uploadLimit: input.rateMbps});
      await this.operationsRepository?.audit({action:"set-upload-limit",mac:device.mac.toString(),deviceId:device.id,details:{rateMilliMbps:input.rateMbps.toString(),result:"success"}});
    } catch (error) {
      await this.operationsRepository?.audit({action:"set-upload-limit",mac:device.mac.toString(),deviceId:device.id,details:{result:"failure",error:error instanceof Error?error.message:String(error)}});
      throw error;
    }
  }

  /*
   * ============================================================
   * CLEAR DOWNLOAD LIMIT
   * ============================================================
   */

  async clearDownload(
    mac: string,
  ): Promise<void> {
    const device =
      await resolveDeviceIdentifier(this.deviceRepository, mac);

    if (!device) {
      throw new Error(
        `Device not found: ${mac}`,
      );
    }

    await this.trafficEnforcer.clearDownload(
      device,
    );

    await this.policyRepository.upsert(
      device.id,
      {
        downloadLimit: null,
      },
    );
    await this.clearBaseStateWhenUnused();
  }

  /*
   * ============================================================
   * CLEAR UPLOAD LIMIT
   * ============================================================
   */

  async clearUpload(
    mac: string,
  ): Promise<void> {
    const device =
      await resolveDeviceIdentifier(this.deviceRepository, mac);

    if (!device) {
      throw new Error(
        `Device not found: ${mac}`,
      );
    }

    await this.trafficEnforcer.clearUpload(
      device,
    );

    await this.policyRepository.upsert(
      device.id,
      {
        uploadLimit: null,
      },
    );
    await this.clearBaseStateWhenUnused();
  }

  private async clearBaseStateWhenUnused(): Promise<void> {
    const devices = await this.deviceRepository.findAll();
    for (const device of devices) {
      const policy = await this.policyRepository.findByDeviceId(device.id);
      if (policy && (policy.downloadLimit !== null || policy.uploadLimit !== null)) return;
    }
    await this.trafficEnforcer.clearBaseState();
  }

  /*
   * ============================================================
   * QUOTA THROTTLE
   * ============================================================
   *
   * Temporary 0.5 Mbps throttle used when the
   * quota action is "throttle".
   *
   * IMPORTANT:
   *
   * This does NOT modify downloadLimit/uploadLimit
   * in DevicePolicy.
   *
   * The user's normal manual limits remain stored
   * in the database.
   */

  async applyQuotaThrottle(
    mac: string,
  ): Promise<void> {
    const device =
      await resolveDeviceIdentifier(this.deviceRepository, mac);

    if (!device) {
      throw new Error(
        `Device not found: ${mac}`,
      );
    }

    /*
     * 0.5 Mbps =
     *
     * 500,000 bits/sec
     */
    if (!Number.isFinite(this.quotaThrottleMbps) || this.quotaThrottleMbps <= 0) {
      throw new Error("Quota throttle rate must be greater than zero");
    }

    const bitsPerSecond =
      BigInt(Math.round(this.quotaThrottleMbps * 1_000_000));

    /*
     * Download is enforced on the physical
     * interface in the single-interface setup.
     */
    await this.trafficEnforcer.limitDownloadBits(
      device,
      bitsPerSecond,
    );

    /*
     * Upload is enforced through IFB.
     */
    await this.trafficEnforcer.limitUploadBits(
      device,
      bitsPerSecond,
    );
  }

  /*
   * ============================================================
   * CLEAR QUOTA THROTTLE
   * ============================================================
   *
   * Restore the user's normal manual policy.
   *
   * The quota throttle itself is NOT stored in
   * DevicePolicy.downloadLimit/uploadLimit.
   */

  async clearQuotaThrottle(
    mac: string,
  ): Promise<void> {
    const device =
      await resolveDeviceIdentifier(this.deviceRepository, mac);

    if (!device) {
      throw new Error(
        `Device not found: ${mac}`,
      );
    }

    const policy =
      await this.policyRepository.findByDeviceId(
        device.id,
      );

    /*
     * No policy means there is no manual speed
     * policy to restore.
     */
    if (!policy) {
      await this.trafficEnforcer.clearDownload(
        device,
      );

      await this.trafficEnforcer.clearUpload(
        device,
      );

      return;
    }

    /*
     * ==========================================================
     * RESTORE DOWNLOAD
     * ==========================================================
     */

    if (
      policy.downloadLimit !== null
    ) {
      await this.trafficEnforcer.limitDownload(
        device,
        {
          rateMbps:
            policy.downloadLimit,
        },
      );
    } else {
      await this.trafficEnforcer.clearDownload(
        device,
      );
    }

    /*
     * ==========================================================
     * RESTORE UPLOAD
     * ==========================================================
     */

    if (
      policy.uploadLimit !== null
    ) {
      await this.trafficEnforcer.limitUpload(
        device,
        {
          rateMbps:
            policy.uploadLimit,
        },
      );
    } else {
      await this.trafficEnforcer.clearUpload(
        device,
      );
    }
  }
}
