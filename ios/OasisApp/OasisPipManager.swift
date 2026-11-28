import AVFoundation
import AVKit
import CoreMedia
import CoreVideo
import UIKit

@MainActor
final class OasisPipManager: NSObject, AVPictureInPictureControllerDelegate, AVPictureInPictureSampleBufferPlaybackDelegate {
    private let displayLayer = AVSampleBufferDisplayLayer()
    private let hostView = UIView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
    private var pipController: AVPictureInPictureController?
    private var autoPipEnabled = false
    private var isActive = false
    private var renderSize = CGSize(width: 480, height: 360)

    var onStateChanged: ((Bool) -> Void)?

    var isSupported: Bool {
        AVPictureInPictureController.isPictureInPictureSupported()
    }

    func attach(to parentView: UIView) {
        guard isSupported else { return }
        hostView.backgroundColor = .clear
        hostView.isUserInteractionEnabled = false
        hostView.alpha = 0.01
        displayLayer.frame = CGRect(x: 0, y: 0, width: 480, height: 360)
        displayLayer.videoGravity = .resizeAspectFill
        hostView.layer.addSublayer(displayLayer)
        parentView.insertSubview(hostView, at: 0)

        configureAudioSession()

        let contentSource = AVPictureInPictureController.ContentSource(
            sampleBufferDisplayLayer: displayLayer,
            playbackDelegate: self
        )
        let controller = AVPictureInPictureController(contentSource: contentSource)
        controller.delegate = self
        controller.canStartPictureInPictureAutomaticallyFromInline = autoPipEnabled
        controller.requiresLinearPlayback = true
        self.pipController = controller
    }

    private func configureAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .moviePlayback, options: [.mixWithOthers])
            try session.setActive(true)
        } catch {
            // 静音会话配置失败时不阻塞主界面
        }
    }

    func setAutoPip(_ enabled: Bool) {
        autoPipEnabled = enabled
        if enabled {
            configureAudioSession()
        }
        pipController?.canStartPictureInPictureAutomaticallyFromInline = enabled
    }

    func start() -> [String: Any] {
        guard isSupported, let controller = pipController else {
            return ["ok": false, "message": "当前设备暂不支持系统画中画悬浮窗"]
        }
        configureAudioSession()
        if controller.isPictureInPictureActive {
            return ["ok": true, "active": true]
        }
        controller.startPictureInPicture()
        return ["ok": true, "active": true]
    }

    func stop() -> [String: Any] {
        if let controller = pipController, controller.isPictureInPictureActive {
            controller.stopPictureInPicture()
        }
        return ["ok": true, "active": false]
    }

    func pushFrame(base64Jpeg: String) {
        guard !base64Jpeg.isEmpty,
              let data = Data(base64Encoded: base64Jpeg),
              let image = UIImage(data: data),
              let cgImage = image.cgImage else { return }

        let width = cgImage.width
        let height = cgImage.height
        guard width > 0, height > 0 else { return }

        if CGSize(width: width, height: height) != renderSize {
            renderSize = CGSize(width: width, height: height)
            pipController?.invalidatePlaybackState()
        }

        if displayLayer.status == .failed {
            displayLayer.flush()
        }

        guard let sampleBuffer = makeSampleBuffer(from: cgImage, width: width, height: height) else { return }
        displayLayer.enqueue(sampleBuffer)
    }

    private func makeSampleBuffer(from cgImage: CGImage, width: Int, height: Int) -> CMSampleBuffer? {
        var pixelBuffer: CVPixelBuffer?
        let attrs: [CFString: Any] = [
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true,
            kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary
        ]
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            width,
            height,
            kCVPixelFormatType_32BGRA,
            attrs as CFDictionary,
            &pixelBuffer
        )
        guard status == kCVReturnSuccess, let pb = pixelBuffer else { return nil }

        CVPixelBufferLockBaseAddress(pb, [])
        defer { CVPixelBufferUnlockBaseAddress(pb, []) }

        guard let baseAddress = CVPixelBufferGetBaseAddress(pb) else { return nil }
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pb)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
        guard let ctx = CGContext(
            data: baseAddress,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: bitmapInfo
        ) else { return nil }

        ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))

        var formatDescription: CMVideoFormatDescription?
        guard CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pb,
            formatDescriptionOut: &formatDescription
        ) == noErr, let formatDesc = formatDescription else { return nil }

        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: 15),
            presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()),
            decodeTimeStamp: .invalid
        )
        var sampleBuffer: CMSampleBuffer?
        guard CMSampleBufferCreateReadyWithImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pb,
            formatDescription: formatDesc,
            sampleTiming: &timing,
            sampleBufferOut: &sampleBuffer
        ) == noErr, let sb = sampleBuffer else { return nil }

        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: true) {
            let dict = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
            CFDictionarySetValue(
                dict,
                Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()
            )
        }
        return sb
    }

    // MARK: - AVPictureInPictureControllerDelegate
    nonisolated func pictureInPictureControllerDidStartPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        Task { @MainActor in
            self.isActive = true
            self.onStateChanged?(true)
        }
    }

    nonisolated func pictureInPictureControllerDidStopPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        Task { @MainActor in
            self.isActive = false
            self.onStateChanged?(false)
        }
    }

    nonisolated func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, failedToStartPictureInPictureWithError error: Error) {
        Task { @MainActor in
            self.isActive = false
            self.onStateChanged?(false)
        }
    }

    // MARK: - AVPictureInPictureSampleBufferPlaybackDelegate
    nonisolated func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, setPlaying playing: Bool) {}

    nonisolated func pictureInPictureControllerTimeRangeForPlayback(_ pictureInPictureController: AVPictureInPictureController) -> CMTimeRange {
        CMTimeRange(start: .zero, duration: .positiveInfinity)
    }

    nonisolated func pictureInPictureControllerIsPlaybackPaused(_ pictureInPictureController: AVPictureInPictureController) -> Bool {
        false
    }

    nonisolated func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, didTransitionToRenderSize newRenderSize: CMVideoDimensions) {}

    nonisolated func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, skipByInterval skipInterval: CMTime, completion completionHandler: @escaping () -> Void) {
        completionHandler()
    }
}
